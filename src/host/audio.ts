import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { childCompletion, terminateChild } from './media-process';

export function audioHelper() {
  const directory = typeof __dirname === 'string' ? __dirname : path.resolve('src/host');
  return [
    process.env.SIM_RELAY_AUDIO_HELPER,
    path.join(directory, 'sim-relay-audio'),
    path.join(directory, '../dist-host/sim-relay-audio'),
    path.join(directory, '../host/sim-relay-audio'),
    path.join(
      (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? directory,
      'host/sim-relay-audio',
    ),
    path.resolve('dist-host/sim-relay-audio'),
  ].find((file): file is string => !!file && existsSync(file));
}
export interface AudioCapture {
  close(): Promise<void>;
}
export type AudioFactory = (
  frame: (pcm: Buffer) => void,
  error: (error: Error) => void,
  signal: AbortSignal,
) => Promise<AudioCapture>;

/** Arbitrary pipe boundaries in, bounded PCM packets out. Reject before allocating. */
export class AudioFramer {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    if (chunk.length + this.pending.length > 256 * 1024)
      throw new Error('Audio pipe exceeded its buffer limit.');
    this.pending = Buffer.concat([this.pending, chunk]);
    const packets: Buffer[] = [];
    while (this.pending.length >= 4) {
      const size = this.pending.readUInt32LE();
      if (!size || size > 3840 || size % 4) throw new Error('Invalid PCM audio packet.');
      if (this.pending.length < size + 4) break;
      packets.push(this.pending.subarray(4, size + 4));
      this.pending = this.pending.subarray(size + 4);
    }
    return packets;
  }
}
export const nativeAudio: AudioFactory = async (frame, onError, signal) => {
  signal.throwIfAborted();
  const helper = audioHelper();
  if (!helper) throw new Error('Rebuild/install the Mac host audio helper before enabling audio.');
  const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const done = childCompletion(child);
  let closed = false;
  let pendingPcm: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const framer = new AudioFramer();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      signal.removeEventListener('abort', abort);
      await terminateChild(child, done, () => child.stdin.end());
    })());
  const abort = () => {
    void close();
  };
  signal.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', (chunk: Buffer) => {
    if (closed) return;
    try {
      for (const pcm of framer.push(chunk)) {
        pendingPcm = Buffer.concat([pendingPcm, pcm]);
        while (pendingPcm.length >= 3840) {
          frame(pendingPcm.subarray(0, 3840));
          pendingPcm = pendingPcm.subarray(3840);
        }
      }
    } catch (error) {
      onError(error as Error);
      void close();
    }
  });
  let diagnostics = '';
  child.stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-3000);
  });
  void done.then(
    () => {
      if (!closed) onError(new Error('Mac audio capture stopped. Enable audio again to retry.'));
    },
    () => {
      if (!closed)
        onError(
          new Error(
            diagnostics ||
              'Mac audio capture failed. Check Screen & System Audio Recording permission.',
          ),
        );
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              'Audio capture did not start. Approve Screen & System Audio Recording on the Mac, then retry.',
            ),
          ),
        20000,
      );
      const ready = () => {
        if (diagnostics.includes('SIM_RELAY_AUDIO_READY')) finish();
      };
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.stderr.off('data', ready);
        error ? reject(error) : resolve();
      };
      child.stderr.on('data', ready);
      void done.then(
        () => finish(new Error(diagnostics || 'Audio capture stopped.')),
        () => finish(new Error(diagnostics || 'Audio capture failed.')),
      );
    });
    signal.throwIfAborted();
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
};

/** Host-wide capture must have local opt-in and only one remote owner at a time. */
export class AudioCoordinator {
  private owner?: object;
  constructor(
    readonly enabled = process.env.SIM_RELAY_ENABLE_HOST_AUDIO === '1',
    readonly factory: AudioFactory = nativeAudio,
  ) {}
  async start(
    owner: object,
    frame: (pcm: Buffer) => void,
    error: (e: Error) => void,
    signal: AbortSignal,
  ): Promise<AudioCapture> {
    if (!this.enabled)
      throw new Error(
        'The Mac owner must enable host-wide audio with SIM_RELAY_ENABLE_HOST_AUDIO=1 and restart the host. This shares sound from every Mac app.',
      );
    if (this.owner)
      throw new Error(
        'Mac audio is already shared by another simulator session. Stop audio there first.',
      );
    this.owner = owner;
    try {
      const capture = await this.factory(frame, error, signal);
      let closing: Promise<void> | undefined;
      return {
        close: () =>
          (closing ??= (async () => {
            await capture.close();
            // Keep ownership on cleanup failure rather than permit a second capture
            // while the previous host-wide source may still be running.
            if (this.owner === owner) this.owner = undefined;
          })()),
      };
    } catch (error) {
      if (this.owner === owner) this.owner = undefined;
      throw error;
    }
  }
}
