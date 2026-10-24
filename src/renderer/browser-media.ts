import { feedbackSchema, qualitySchema } from '../host/adaptive';
import { defaultQuality } from '../shared/media';
import type {
  MediaAction,
  MediaNotice,
  MediaCapabilities,
  QualityLimits,
  RecordingDownload,
  VideoFeedback,
} from '../shared/media';

/** Per-tab media commands and bounded decode delivery. Closing never leaves command timers alive. */
export class BrowserMedia {
  private pending = new Map<
    string,
    {
      resolve(value?: RecordingDownload): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private framePending = false;
  private latest?: Uint8Array;
  private replaced = 0;
  private epoch = 0;
  private capabilities?: MediaCapabilities;
  readonly frames = new Set<(frame: Uint8Array) => void | Promise<void>>();
  readonly audio = new Set<(pcm: Uint8Array) => void>();
  readonly notices = new Set<(notice: MediaNotice) => void>();
  private latestNotices = new Map<string, MediaNotice>();
  constructor(private write: (value: unknown) => void) {}
  open(fps: number) {
    this.notify({ type: 'quality-state', limits: defaultQuality(fps) });
  }
  notify(value: MediaNotice) {
    if (value.type === 'media-capabilities') this.capabilities = value.capabilities;
    this.latestNotices.set(value.type, value);
    for (const callback of this.notices) callback(value);
  }
  subscribe(callback: (notice: MediaNotice) => void) {
    this.notices.add(callback);
    queueMicrotask(() => {
      if (this.notices.has(callback))
        for (const value of this.latestNotices.values()) callback(value);
    });
    return () => {
      this.notices.delete(callback);
    };
  }
  command(action: MediaAction, hostAudioConsent?: boolean): Promise<RecordingDownload | undefined> {
    if (
      !this.capabilities ||
      (action === 'recording-start' && this.capabilities.recording !== true) ||
      (action === 'audio-start' && this.capabilities.audio !== true)
    )
      return Promise.reject(
        new Error(
          'This Mac has not enabled this media feature. Check its setup or update the host.',
        ),
      );
    if (this.pending.size >= 8)
      return Promise.reject(new Error('Wait for the current media action, then retry.'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(
            new Error('The Mac did not finish the media action. Reconnect the display and retry.'),
          );
        },
        action.startsWith('recording-') ? 65_000 : 15_000,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ type: 'media-control', id, action, hostAudioConsent });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  quality(limits: QualityLimits) {
    if (this.capabilities?.adaptive !== true)
      throw new Error(
        'This Mac does not support adaptive video. Update its host to change quality.',
      );
    const checked = qualitySchema.parse(limits);
    this.write({ type: 'quality', limits: checked });
    this.notify({ type: 'quality-state', limits: checked });
  }
  feedback(value: VideoFeedback) {
    if (this.capabilities?.adaptive !== true) return;
    const feedback = feedbackSchema.parse(value);
    this.write({
      type: 'video-feedback',
      feedback: { ...feedback, dropped: Math.min(10000, feedback.dropped + this.replaced) },
    });
    this.replaced = 0;
  }
  video(data: Uint8Array) {
    if (data.length > 16 * 1024 * 1024) return;
    if (this.framePending) {
      if (this.latest) this.replaced++;
      this.latest = data;
      return;
    }
    if (!this.frames.size) return;
    this.framePending = true;
    const epoch = this.epoch;
    void Promise.allSettled(
      [...this.frames].map((callback) => Promise.resolve().then(() => callback(data))),
    ).then(() => {
      if (epoch !== this.epoch) return;
      this.framePending = false;
      const latest = this.latest;
      this.latest = undefined;
      if (latest) this.video(latest);
    });
  }
  /** Returns true for additive media messages; metadata remains owned by RelaySession. */
  message(data: Uint8Array | string): boolean {
    if (typeof data !== 'string') {
      if (data[0] !== 83 || data[1] !== 82 || data[2] !== 65 || data[3] !== 49) return false;
      if (data.length >= 8 && data.length <= 3844 && (data.length - 4) % 4 === 0)
        for (const callback of this.audio) callback(data.subarray(4));
      return true;
    }
    const value = JSON.parse(data);
    if (value?.type === 'media-ping') {
      if (this.capabilities?.adaptive === true && Number.isFinite(value.sentAt))
        try {
          this.write({ type: 'media-pong', sentAt: value.sentAt });
        } catch {
          /* Closing transports may skip a sample. */
        }
      return true;
    }
    if (value?.type === 'media-result') {
      const pending = this.pending.get(value.id);
      if (pending) {
        this.pending.delete(value.id);
        clearTimeout(pending.timer);
        value.error ? pending.reject(new Error(value.error)) : pending.resolve(value.result);
      }
      return true;
    }
    if (['recording', 'audio', 'metrics', 'media-capabilities'].includes(value?.type)) {
      this.notify(value);
      return true;
    }
    return false;
  }
  close() {
    this.epoch++;
    this.framePending = false;
    this.latest = undefined;
    this.replaced = 0;
    this.latestNotices.clear();
    this.capabilities = undefined;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(
        new Error('Display disconnected. Audio stopped and temporary recordings were discarded.'),
      );
    }
    this.pending.clear();
    this.notify({ type: 'audio', active: false });
    this.notify({ type: 'recording', recording: { phase: 'idle' } });
  }
}
