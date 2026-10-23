import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocket } from 'ws';
import type { Profile } from '../shared/types';
import type {
  MediaAction,
  MediaNotice,
  QualityLimits,
  RecordingDownload,
  VideoFeedback,
} from '../shared/media';
import { feedbackSchema, qualitySchema } from '../host/adaptive';
import { hostUrl, tlsOptions } from './remote';

export async function downloadRecording(
  profile: Profile,
  recording: RecordingDownload,
  target: string,
  signal: AbortSignal,
  progress: (bytes: number) => void,
) {
  if (
    !/^[\da-f-]{36}$/i.test(recording.id) ||
    !/^[\da-f]{64}$/i.test(recording.ticket) ||
    !Number.isSafeInteger(recording.bytes) ||
    recording.bytes < 32 ||
    recording.bytes > 1056 * 1024 * 1024
  )
    throw new Error('The host returned invalid recording details.');
  const temporary = `${target}.partial-${randomUUID()}`;
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const request = https.get(
        new URL(`/recordings/${recording.id}`, hostUrl(profile.url)),
        {
          ...tlsOptions(profile),
          signal,
          timeout: 30000,
          headers: {
            Authorization: `Bearer ${profile.token}`,
            'X-Recording-Ticket': recording.ticket,
          },
        },
        (response) => {
          if (
            response.statusCode !== 200 ||
            Number(response.headers['content-length']) !== recording.bytes
          ) {
            response.resume();
            reject(
              new Error(
                'Recording is no longer available. Keep the simulator connected and try again.',
              ),
            );
            return;
          }
          let bytes = 0,
            notified = 0;
          const count = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              bytes += chunk.length;
              if (bytes > recording.bytes) {
                done(new Error('Recording exceeded its expected size.'));
                return;
              }
              if (bytes - notified >= 256 * 1024 || bytes === recording.bytes) {
                progress(bytes);
                notified = bytes;
              }
              done(null, chunk);
            },
          });
          void pipeline(
            response,
            count,
            createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
            { signal },
          ).then(
            () =>
              bytes === recording.bytes
                ? resolve()
                : reject(new Error('Recording transfer was interrupted. Try Save again.')),
            reject,
          );
        },
      );
      request.on('timeout', () =>
        request.destroy(
          new Error('Recording transfer stalled. Check the connection and try Save again.'),
        ),
      );
      request.on('error', reject);
    });
    signal.throwIfAborted();
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** One instance per display connection/window. No media state is process-global. */
export class ClientMedia {
  private pending = new Map<
    string,
    {
      resolve(value?: RecordingDownload): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private disposed = false;
  private abort = new AbortController();
  private framePending = false;
  private audioPending = false;
  private latest?: Buffer;
  private replaced = 0;
  private saving = false;
  private saveFinished?: Promise<void>;
  private finishSave?: () => void;
  constructor(
    private socket: WebSocket,
    private profile: Profile,
    private send: (channel: string, value: unknown) => void,
  ) {}
  private write(value: unknown) {
    if (this.disposed || this.socket.readyState !== WebSocket.OPEN)
      throw new Error('Connect to a simulator first.');
    if (this.socket.bufferedAmount > 64 * 1024)
      throw new Error('The connection is busy. Wait and retry.');
    this.socket.send(JSON.stringify(value));
  }
  command(action: MediaAction, hostAudioConsent?: boolean): Promise<RecordingDownload | undefined> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(
            new Error(
              'The host did not finish the media action. Reconnect to release capture resources.',
            ),
          );
        },
        action.startsWith('recording-') ? 65000 : 35000,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ type: 'media-control', id, action, hostAudioConsent });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  quality(limits: QualityLimits) {
    this.write({ type: 'quality', limits: qualitySchema.parse(limits) });
  }
  feedback(feedback: VideoFeedback) {
    const checked = feedbackSchema.parse(feedback);
    this.write({
      type: 'video-feedback',
      feedback: { ...checked, dropped: Math.min(10000, checked.dropped + this.replaced) },
    });
    this.replaced = 0;
  }
  /** At most one IPC frame and one replacement frame per window, including slow/hidden renderers. */
  video(data: Buffer) {
    if (this.disposed) return;
    if (this.framePending) {
      if (this.latest) this.replaced++;
      this.latest = data;
      return;
    }
    this.framePending = true;
    this.send('frame', new Uint8Array(data));
  }
  consumed() {
    this.framePending = false;
    const latest = this.latest;
    this.latest = undefined;
    if (latest) this.video(latest);
  }
  consumedAudio() {
    this.audioPending = false;
  }
  /** Returns true when handled; ordinary metadata/input notices remain with the display owner. */
  message(data: Buffer, binary: boolean): boolean {
    if (this.disposed) return true;
    if (binary) {
      if (data.subarray(0, 4).toString() !== 'SRA1') return false;
      if (data.length > 3844 || data.length < 8 || (data.length - 4) % 4) return true;
      if (!this.audioPending) {
        this.audioPending = true;
        this.send('audio-frame', new Uint8Array(data.subarray(4)));
      }
      return true;
    }
    let value: MediaNotice | { type: 'media-ping'; sentAt: number };
    try {
      value = JSON.parse(data.toString());
    } catch {
      return false;
    }
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') return false;
    if (value.type === 'media-ping') {
      try {
        this.write({ type: 'media-pong', sentAt: value.sentAt });
      } catch {
        /* A closing/busy socket can skip this measurement. */
      }
      return true;
    }
    if (value.type === 'media-result') {
      const pending = this.pending.get(value.id);
      if (pending) {
        this.pending.delete(value.id);
        clearTimeout(pending.timer);
        value.error ? pending.reject(new Error(value.error)) : pending.resolve(value.result);
      }
      return true;
    }
    if (['recording', 'audio', 'metrics', 'media-capabilities'].includes(value.type)) {
      this.send('media-notice', value);
      return true;
    }
    return false;
  }
  async save(choose: () => Promise<string | undefined>): Promise<boolean> {
    if (this.saving) throw new Error('A recording save is already in progress.');
    this.saving = true;
    this.saveFinished = new Promise((resolve) => {
      this.finishSave = resolve;
    });
    try {
      const recording = await this.command('recording-stop');
      if (!recording) throw new Error('The host did not provide a recording.');
      let canceled: (() => void) | undefined;
      let target: string | undefined;
      try {
        target = await Promise.race([
          choose(),
          new Promise<undefined>((resolve) => {
            canceled = () => resolve(undefined);
            this.abort.signal.addEventListener('abort', canceled, { once: true });
            if (this.abort.signal.aborted) canceled();
          }),
        ]);
      } finally {
        if (canceled) this.abort.signal.removeEventListener('abort', canceled);
      }
      if (!target || this.disposed) return false;
      this.send('media-notice', { type: 'recording', recording: { phase: 'saving', bytes: 0 } });
      try {
        await downloadRecording(this.profile, recording, target, this.abort.signal, (bytes) =>
          this.send('media-notice', {
            type: 'recording',
            recording: {
              phase: 'saving',
              bytes,
              message: `${Math.round((bytes / recording.bytes) * 100)}% saved`,
            },
          }),
        );
      } catch (error) {
        this.send('media-notice', {
          type: 'recording',
          recording: { phase: 'ready', bytes: recording.bytes, message: (error as Error).message },
        });
        throw error;
      }
      await this.command('recording-discard');
      return true;
    } finally {
      this.saving = false;
      this.finishSave?.();
    }
  }
  close() {
    if (this.disposed) return this.saveFinished ?? Promise.resolve();
    this.disposed = true;
    this.abort.abort();
    this.latest = undefined;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(
        new Error(
          'Simulator disconnected. Capture stopped and temporary recordings were discarded.',
        ),
      );
    }
    this.pending.clear();
    this.send('media-notice', { type: 'audio', active: false });
    this.send('media-notice', { type: 'recording', recording: { phase: 'idle' } });
    return this.saveFinished ?? Promise.resolve();
  }
}
