import { z } from 'zod';
import type { QualityLimits, StreamMetrics, VideoFeedback, VideoSettings } from '../shared/media';
import { defaultQuality } from '../shared/media';

export const qualitySchema = z.object({
  mode: z.enum(['auto', 'manual']),
  maxFps: z.number().int().min(5).max(60),
  maxScale: z.number().min(0.35).max(1),
  quality: z.number().min(0.35).max(0.9),
  maxKbps: z.number().int().min(256).max(100000),
});
export const feedbackSchema = z.object({
  decoded: z.number().int().min(0).max(600),
  dropped: z.number().int().min(0).max(10000),
  decodeMs: z.number().min(0).max(10000),
  intervalMs: z.number().min(250).max(10000),
});

/** A byte token bucket drops obsolete frames; never queues them for later. */
export class AdaptiveVideo {
  limits: QualityLimits;
  settings: VideoSettings;
  private level = 0;
  private healthy = 0;
  private bytes = 0;
  private sent = 0;
  private dropped = 0;
  private tokens: number;
  private tokenAt: number;
  private sampleAt: number;
  private sentAt = -Infinity;
  private feedback?: VideoFeedback;
  private feedbackAt = 0;
  roundTripMs?: number;
  constructor(
    fps = 30,
    private now = () => performance.now(),
  ) {
    this.limits = defaultQuality(fps);
    this.settings = this.resolve();
    this.sampleAt = this.tokenAt = now();
    this.tokens = this.capacity;
  }
  private get capacity() {
    return this.limits.maxKbps * 125 * 0.5;
  }
  private resolve(): VideoSettings {
    const l = this.limits,
      n = l.mode === 'auto' ? this.level : 0;
    return {
      fps: Math.max(5, Math.round(l.maxFps * [1, 0.8, 0.6, 0.4, 0.25][n])),
      scale: Math.min(l.maxScale, [1, 0.85, 0.7, 0.55, 0.4][n]),
      quality: Math.min(l.quality, [0.9, 0.7, 0.6, 0.5, 0.4][n]),
    };
  }
  configure(value: unknown) {
    this.limits = qualitySchema.parse(value);
    this.level = this.healthy = 0;
    this.tokens = this.capacity;
    this.settings = this.resolve();
  }
  report(value: unknown) {
    this.feedback = feedbackSchema.parse(value);
    this.feedbackAt = this.now();
  }
  allow(bytes: number, buffered: number): boolean {
    const now = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.tokenAt) * this.limits.maxKbps) / 8,
    );
    this.tokenAt = now;
    // At most one oversized frame may burst through; its debt must refill first.
    if (
      bytes > Math.min(2 * 1024 * 1024, Math.max(64 * 1024, this.capacity)) ||
      buffered > Math.min(256 * 1024, Math.max(16 * 1024, this.capacity * 0.3)) ||
      now - this.sentAt < 1000 / this.settings.fps - 1 ||
      this.tokens < Math.min(bytes, this.capacity)
    ) {
      this.dropped++;
      return false;
    }
    this.tokens -= bytes;
    this.bytes += bytes;
    this.sent++;
    this.sentAt = now;
    return true;
  }
  sample(): StreamMetrics | undefined {
    const elapsed = this.now() - this.sampleAt;
    if (elapsed < 2000) return;
    const f = this.now() - this.feedbackAt < 5000 ? this.feedback : undefined;
    const total = this.sent + this.dropped;
    const pressure =
      (total > 0 && this.dropped / total > 0.18) ||
      !!(f && (f.decodeMs > (1000 / this.settings.fps) * 0.8 || f.dropped > f.decoded * 0.15));
    if (this.limits.mode === 'auto') {
      if (pressure) {
        this.level = Math.min(4, this.level + 1);
        this.healthy = 0;
      } else if (this.sent > 0 && ++this.healthy >= 4) {
        this.level = Math.max(0, this.level - 1);
        this.healthy = 0;
      }
      this.settings = this.resolve();
    }
    const metrics: StreamMetrics = {
      kbps: (this.bytes * 8) / elapsed,
      sentFps: (this.sent * 1000) / elapsed,
      dropped: this.dropped,
      decodedFps: f ? (f.decoded * 1000) / f.intervalMs : undefined,
      decodeMs: f?.decodeMs,
      roundTripMs: this.roundTripMs,
      settings: { ...this.settings },
      mode: this.limits.mode,
    };
    this.bytes = this.sent = this.dropped = 0;
    this.sampleAt = this.now();
    return metrics;
  }
}
