import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, readdir, open } from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { RecordingDownload, RecordingStatus } from '../shared/media';
import { childCompletion, spawnRecording, terminateChild } from './media-process';

const MAX_BYTES = 1024 * 1024 * 1024;
export interface RecordingCapture {
  stop(): Promise<void>;
  abort(): Promise<void>;
  finished?: Promise<void>;
}
export type RecordingFactory = (
  udid: string,
  file: string,
  signal: AbortSignal,
) => Promise<RecordingCapture>;
export const nativeRecording: RecordingFactory = async (udid, file, signal) => {
  signal.throwIfAborted();
  const child: ChildProcess = spawnRecording(udid, file);
  let diagnostics = '';
  const diagnostic = (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk).slice(-3000);
  };
  child.stderr?.on('data', diagnostic);
  const done = childCompletion(child).catch((error: Error) => {
    throw new Error(`${error.message} ${diagnostics.trim()}`);
  });
  void done.catch(() => {});
  const abort = () => {
    void terminateChild(child, done, () => child.stdin?.end(), 35000);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error('Recording did not start. Check Xcode and that the simulator is booted.'),
          ),
        15000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.stderr?.off('data', data);
        error ? reject(error) : resolve();
      };
      const data = () => {
        if (/Recording started/i.test(diagnostics)) finish();
      };
      child.stderr?.on('data', data);
      void done.then(
        () => finish(new Error(`Recording stopped before it started. ${diagnostics}`)),
        () => finish(new Error(`Cannot record. ${diagnostics}`)),
      );
      if (signal.aborted) finish(new Error('Recording canceled.'));
    });
    signal.throwIfAborted();
    let stopped: Promise<void> | undefined;
    return {
      finished: done,
      stop: () =>
        (stopped ??= (async () => {
          await terminateChild(child, done, () => child.stdin?.end(), 35000);
          await done;
          child.stderr?.off('data', diagnostic);
          signal.removeEventListener('abort', abort);
        })()),
      abort: async () => {
        await terminateChild(child, done, () => child.stdin?.end(), 35000);
        child.stderr?.off('data', diagnostic);
        signal.removeEventListener('abort', abort);
      },
    };
  } catch (error) {
    await terminateChild(child, done, () => child.stdin?.end(), 35000);
    child.stderr?.off('data', diagnostic);
    signal.removeEventListener('abort', abort);
    throw error;
  }
};

export class RecordingStore {
  private entries = new Map<string, Recording>();
  constructor(
    readonly directory: string,
    readonly factory: RecordingFactory = nativeRecording,
  ) {}
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Crash leftovers are never downloadable (tickets live only in memory).
    for (const name of await readdir(this.directory)) {
      if (!/^capture-[\w-]+$/.test(name)) continue;
      const file = path.join(this.directory, name);
      if (Date.now() - (await stat(file)).mtimeMs > 60 * 60 * 1000)
        await rm(file, { recursive: true, force: true });
    }
  }
  create(udid: string, notify: (status: RecordingStatus) => void) {
    const recording = new Recording(this, udid, notify);
    this.entries.set(recording.id, recording);
    return recording;
  }
  download(id: string, ticket: string | undefined) {
    const item = this.entries.get(id);
    if (
      !item ||
      !ticket ||
      !item.ready ||
      !/^[\da-f]{64}$/i.test(ticket) ||
      !timingSafeEqual(Buffer.from(ticket), Buffer.from(item.ticket))
    )
      return;
    return { file: item.file, bytes: item.bytes };
  }
  remove(id: string) {
    this.entries.delete(id);
  }
}
export class Recording {
  readonly id = randomUUID();
  readonly ticket = randomBytes(32).toString('hex');
  file = '';
  bytes = 0;
  ready = false;
  private directory = '';
  private capture?: RecordingCapture;
  private startup?: Promise<void>;
  private stopping?: Promise<RecordingDownload>;
  private closing?: Promise<void>;
  private closed = false;
  private abort = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private expires?: ReturnType<typeof setTimeout>;
  private startedAt = Date.now();
  constructor(
    private store: RecordingStore,
    private udid: string,
    private notify: (status: RecordingStatus) => void,
  ) {}
  start() {
    return (this.startup ??= (async () => {
      this.notify({ phase: 'starting' });
      try {
        this.directory = await mkdtemp(path.join(this.store.directory, 'capture-'));
        this.file = path.join(this.directory, 'screen.mp4');
        this.abort.signal.throwIfAborted();
        this.capture = await this.store.factory(this.udid, this.file, this.abort.signal);
        this.abort.signal.throwIfAborted();
        this.startedAt = Date.now();
        this.notify({ phase: 'recording', startedAt: this.startedAt });
        this.timer = setInterval(() => {
          void this.checkLimit();
        }, 1000);
        void this.capture.finished?.then(
          () => {
            if (!this.closed && !this.stopping) {
              this.notify({
                phase: 'error',
                message:
                  'The simulator stopped recording. Start a new recording after reconnecting.',
              });
              void this.close();
            }
          },
          (error: Error) => {
            if (!this.closed && !this.stopping) {
              this.notify({ phase: 'error', message: error.message });
              void this.close();
            }
          },
        );
      } catch (e) {
        this.notify({ phase: 'error', message: (e as Error).message });
        throw e;
      }
    })());
  }
  private async checkLimit() {
    try {
      if (Date.now() - this.startedAt > 29 * 60 * 1000 || (await stat(this.file)).size >= MAX_BYTES)
        await this.stop();
    } catch (e) {
      this.notify({ phase: 'error', message: `Recording stopped: ${(e as Error).message}` });
      await this.close();
    }
  }
  stop(): Promise<RecordingDownload> {
    return (this.stopping ??= (async () => {
      await this.startup;
      if (this.closed) throw new Error('Recording was discarded.');
      clearInterval(this.timer);
      this.notify({ phase: 'finalizing', startedAt: this.startedAt });
      await this.capture?.stop();
      if (this.closed) throw new Error('Recording was discarded.');
      this.bytes = (await stat(this.file)).size;
      if (this.bytes < 32 || this.bytes > MAX_BYTES + 32 * 1024 * 1024)
        throw new Error('Recording is empty or too large. Discard it and try a shorter recording.');
      // Check top-level atoms, including the finalized movie index, without buffering the file.
      const file = await open(this.file, 'r');
      try {
        let offset = 0,
          atoms = 0;
        const types = new Set<string>();
        while (offset + 8 <= this.bytes && ++atoms <= 10000) {
          const header = Buffer.alloc(16);
          await file.read(header, 0, Math.min(16, this.bytes - offset), offset);
          const short = header.readUInt32BE();
          const size =
            short === 0
              ? this.bytes - offset
              : short === 1
                ? Number(header.readBigUInt64BE(8))
                : short;
          if (
            !Number.isSafeInteger(size) ||
            size < (short === 1 ? 16 : 8) ||
            offset + size > this.bytes
          )
            break;
          types.add(header.toString('ascii', 4, 8));
          offset += size;
        }
        if (offset !== this.bytes || !['ftyp', 'moov', 'mdat'].every((type) => types.has(type)))
          throw new Error('Recording could not be finalized as MP4. Discard it and try again.');
      } finally {
        await file.close();
      }
      this.ready = true;
      this.notify({ phase: 'ready', startedAt: this.startedAt, bytes: this.bytes });
      this.expires = setTimeout(
        () => {
          void this.close();
        },
        10 * 60 * 1000,
      );
      return { id: this.id, ticket: this.ticket, bytes: this.bytes };
    })());
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      this.ready = false;
      this.abort.abort();
      clearInterval(this.timer);
      clearTimeout(this.expires);
      await this.startup?.catch(() => {});
      await this.capture?.abort().catch(() => {});
      await this.stopping?.catch(() => {});
      if (this.directory) await rm(this.directory, { force: true, recursive: true });
      this.store.remove(this.id);
      this.notify({ phase: 'idle' });
    })());
  }
}
