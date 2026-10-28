import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { RetirementError } from './process';

export interface AppAudio {
  stdout: Readable;
  stderr: Readable;
  completion: Promise<void>;
  close(): Promise<void>;
}

/** Injection points for private fixtures; production always launches LaunchServices. */
export interface AppAudioDependencies {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  isProcessAlive?: (pid: number) => boolean;
  handshakeTimeoutMs?: number;
  retirementTimeoutMs?: number;
}

const bufferLimit = 256 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Never backpressure ownership/EOF monitoring on a slow audio consumer. Drop old PCM. */
class LatestAudio extends Readable {
  private latest?: Buffer;
  constructor() {
    super({ highWaterMark: 3844 });
  }
  _read() {
    if (this.latest) {
      const packet = this.latest;
      this.latest = undefined;
      this.push(packet);
    }
  }
  packet(packet: Buffer) {
    if (this.destroyed || this.readableEnded) return;
    if (this.readableLength >= this.readableHighWaterMark) this.latest = Buffer.from(packet);
    else this.push(Buffer.from(packet));
  }
  finish() {
    this.latest = undefined;
    this.push(null);
  }
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM and all other inconclusive observations must fail closed.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * The socket is the capture ownership lease. `open -W` is only a launch proxy:
 * stopping it never proves the authenticated helper has stopped capturing.
 */
export async function launchAppAudio(
  appPath: string,
  signal: AbortSignal,
  deps: AppAudioDependencies = {},
): Promise<AppAudio> {
  signal.throwIfAborted();
  const directory = await mkdtemp('/tmp/sim-relay-audio-');
  const socketPath = path.join(directory, 's');
  const configPath = path.join(directory, 'config.json');
  const nonce = randomBytes(32).toString('hex');
  const stdout = new LatestAudio();
  const stderr = new Readable({ read() {} });
  const server = createServer({ allowHalfOpen: true });
  let child: ChildProcess | undefined;
  let proxyGone = false;
  let spawnFailed = false;
  let helperPid: number | undefined;
  let owner: Socket | undefined;
  let socketGone = true;
  let acknowledged = false;
  let ready = false;
  let closing = false;
  let closingPromise: Promise<void> | undefined;
  let failure: Error | undefined;
  let launcherDiagnostics = '';
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // Setup/permission failures can precede the consumer attaching its handlers.
  void completion.catch(() => {});

  const redact = (message: string) =>
    message
      .replaceAll(nonce, '[redacted]')
      .replaceAll(configPath, '[private config]')
      .replaceAll(directory, '[private audio directory]');
  const fail = (error: Error) => {
    if (closing) return;
    failure = new Error(redact(error.message));
    void close().catch(() => {});
  };
  const close = () =>
    (closingPromise ??= (async () => {
      closing = true;
      clearTimeout(handshakeTimer);
      signal.removeEventListener('abort', abort);
      // Revoke admission before EOF. A delayed helper cannot load a stale lease.
      let cleanupError: unknown;
      try {
        await rm(configPath, { force: true });
      } catch (error) {
        cleanupError = error;
      }
      server.close();
      // A FIN revokes capture while retaining the read side to drain its shutdown.
      if (owner && !owner.destroyed) owner.end();
      const deadline = Date.now() + Math.max(8000, deps.retirementTimeoutMs ?? 10000);
      const isAlive = deps.isProcessAlive ?? processAlive;
      let retired = false;
      let helperGone = false;
      let proxyStopped = false;
      while (Date.now() < deadline) {
        if (helperPid !== undefined && !helperGone) {
          try {
            helperGone = !isAlive(helperPid);
          } catch {
            // An inconclusive process observation cannot acknowledge retirement.
          }
        }
        // Without an authenticated PID, only a proven spawn failure is safe.
        // Even a successful/failed `open` exit can leave a pending app launch.
        const safe = helperGone || !child || spawnFailed;
        if (safe && !proxyStopped) {
          proxyStopped = true;
          if (child && !proxyGone) {
            try {
              child.kill('SIGTERM');
            } catch {
              /* The deadline below still requires an observed proxy exit. */
            }
          }
        }
        if (safe && (!child || proxyGone) && socketGone) {
          retired = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      // Always remove private files, even when retirement cannot be established.
      owner?.destroy();
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        cleanupError ??= error;
      }
      stdout.finish();
      stderr.push(null);
      if (!retired || cleanupError) {
        const error = new RetirementError(
          'Mac audio helper retirement could not be verified. Restart the Mac host before retrying.',
        );
        rejectCompletion(error);
        throw error;
      }
      if (failure) rejectCompletion(failure);
      else resolveCompletion();
    })());
  const abort = () => {
    failure ??= new Error('Mac audio capture was aborted.');
    void close().catch(() => {});
  };

  server.on('connection', (socket) => {
    if (closing || owner) {
      socket.destroy();
      return;
    }
    owner = socket;
    socketGone = false;
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let hello = false;
    socket.on('error', () => fail(new Error('Mac audio ownership socket failed.')));
    socket.on('close', () => {
      socketGone = true;
      if (!closing) fail(new Error('Mac audio ownership socket disconnected.'));
    });
    socket.on('end', () => {
      if (!closing) {
        fail(
          new Error(pending.length ? 'Truncated Mac audio record.' : 'Mac audio capture stopped.'),
        );
      }
      socket.end();
    });
    socket.on('data', (chunk: Buffer) => {
      if (closing) return; // Keep the read side draining until EOF/process death.
      try {
        if (chunk.length + pending.length > bufferLimit)
          throw new Error('Mac audio socket exceeded its buffer limit.');
        pending = Buffer.concat([pending, chunk]);
        if (!hello) {
          const newline = pending.indexOf(10);
          if (newline === -1) {
            if (pending.length >= 1024) throw new Error('Oversized Mac audio handshake.');
            return;
          }
          if (newline + 1 > 1024) throw new Error('Oversized Mac audio handshake.');
          const value = JSON.parse(utf8.decode(pending.subarray(0, newline)));
          if (
            value?.version !== 1 ||
            typeof value.nonce !== 'string' ||
            !/^[a-f0-9]{64}$/.test(value.nonce) ||
            !timingSafeEqual(Buffer.from(value.nonce, 'hex'), Buffer.from(nonce, 'hex')) ||
            !Number.isSafeInteger(value.pid) ||
            value.pid <= 1 ||
            value.pid > 0x7fffffff ||
            value.pid === process.pid ||
            value.pid === child?.pid
          )
            throw new Error('Invalid Mac audio handshake.');
          helperPid = value.pid;
          hello = true;
          pending = pending.subarray(newline + 1);
          // No helper traffic is allowed between hello and our ACK.
          if (pending.length) throw new Error('Mac audio sent data before ownership approval.');
          socket.pause();
          void rm(configPath, { force: true }).then(
            () => {
              if (!closing) {
                acknowledged = true;
                clearTimeout(handshakeTimer);
                socket.write(Buffer.from([1]));
              }
              socket.resume();
            },
            () => {
              fail(new Error('Could not revoke the private Mac audio launch config.'));
              socket.resume();
            },
          );
          return;
        }
        if (!acknowledged) throw new Error('Mac audio sent data before ownership approval.');
        while (pending.length >= 4) {
          const size = pending.readUInt32LE();
          if (size) {
            if (size > 3840 || size % 4) throw new Error('Invalid PCM audio packet.');
            if (!ready) throw new Error('Mac audio sent PCM before ready.');
            if (pending.length < size + 4) break;
            stdout.packet(pending.subarray(0, size + 4));
            pending = pending.subarray(size + 4);
          } else {
            if (pending.length < 8) break;
            const length = pending.readUInt32LE(4);
            if (!length || length > 4096) throw new Error('Invalid Mac audio control length.');
            if (pending.length < length + 8) break;
            const control = JSON.parse(utf8.decode(pending.subarray(8, length + 8)));
            pending = pending.subarray(length + 8);
            if (control?.type === 'ready' && !ready) {
              ready = true;
              stderr.push('SIM_RELAY_AUDIO_READY\n');
            } else if (
              control?.type === 'error' &&
              typeof control.message === 'string' &&
              control.message.length <= 3000
            ) {
              const message = redact(control.message);
              stderr.push(`${message}\n`);
              fail(new Error(message || 'Mac audio capture failed.'));
              return;
            } else throw new Error('Invalid Mac audio control record.');
          }
        }
      } catch {
        // Never include untrusted JSON (which may contain the nonce) in errors.
        fail(new Error('Invalid Mac audio protocol or capture error.'));
      }
    });
  });
  server.on('error', () => fail(new Error('Mac audio listener failed.')));

  try {
    await chmod(directory, 0o700);
    if (Buffer.byteLength(socketPath) >= 104) throw new Error('Mac audio socket path is too long.');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
    await writeFile(configPath, JSON.stringify({ version: 1, socketPath, nonce }), {
      mode: 0o600,
      flag: 'wx',
    });
    signal.throwIfAborted();
    child = (deps.spawn ?? spawn)(
      '/usr/bin/open',
      ['-n', '-g', '-W', path.resolve(appPath), '--args', '--ipc-config', configPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    child.stderr?.on('data', (chunk: Buffer) => {
      launcherDiagnostics = (launcherDiagnostics + chunk.toString('utf8')).slice(-3000);
    });
    child.on('error', () => {
      if (!child?.pid) {
        spawnFailed = true;
        proxyGone = true;
      }
      fail(new Error('Could not launch the Mac audio app.'));
    });
    child.on('exit', () => {
      proxyGone = true;
      // Even a failed open/GetProcessPID result can precede a valid app hello.
      // Leave admission open until the handshake deadline, regardless of exit code.
    });
    handshakeTimer = setTimeout(
      () =>
        fail(
          new Error(
            `Mac audio app did not authenticate before its startup deadline. ${redact(launcherDiagnostics)}`.trim(),
          ),
        ),
      deps.handshakeTimeoutMs ?? 20000,
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return { stdout, stderr, completion, close };
  } catch {
    failure = new Error('Could not prepare the private Mac audio launch.');
    await close();
    throw failure;
  }
}
