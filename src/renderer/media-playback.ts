import type { DesktopApi } from '../shared/types';

/** Decode completion acknowledges the main-process frame gate. No playback queue. */
export function subscribeVideo(
  api: DesktopApi,
  canvas: () => HTMLCanvasElement | null,
  onFps: (fps: number) => void,
  onError: (message: string) => void,
) {
  let disposed = false,
    count = 0,
    failures = 0,
    decodeTotal = 0,
    started = performance.now();
  const off = api.onFrame(async (frame) => {
    if (disposed) return;
    const start = performance.now();
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(new Blob([new Uint8Array(frame)], { type: 'image/jpeg' }));
      const el = canvas();
      if (!disposed && el) {
        if (el.width !== bitmap.width || el.height !== bitmap.height) {
          el.width = bitmap.width;
          el.height = bitmap.height;
        }
        el.getContext('2d')?.drawImage(bitmap, 0, 0);
        count++;
        decodeTotal += performance.now() - start;
      }
    } catch {
      failures++;
      if (!disposed) onError('Cannot decode the simulator video. Reconnect to try again.');
    } finally {
      bitmap?.close();
    }
  });
  const timer = setInterval(() => {
    const elapsed = performance.now() - started;
    onFps(Math.round((count * 1000) / elapsed));
    api.reportVideoFeedback({
      decoded: count,
      dropped: failures,
      decodeMs: count ? decodeTotal / count : 0,
      intervalMs: Math.min(10000, Math.max(250, elapsed)),
    });
    count = failures = decodeTotal = 0;
    started = performance.now();
  }, 1000);
  return () => {
    disposed = true;
    off();
    clearInterval(timer);
  };
}

/** Default-output playback; volume affects only this client's gain node. */
export class AudioPlayback {
  private context: AudioContext;
  private gain: GainNode;
  private end = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private closed = false;
  constructor() {
    this.context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
  }
  async resume() {
    await this.context.resume();
  }
  volume(value: number, muted: boolean) {
    this.gain.gain.value = muted ? 0 : Math.min(1, Math.max(0, value));
  }
  push(pcm: Uint8Array) {
    if (
      this.closed ||
      this.context.state !== 'running' ||
      !pcm.length ||
      pcm.length > 3840 ||
      pcm.length % 4
    )
      return;
    const now = this.context.currentTime;
    // Freshness wins over preserving old samples. Hard cap on queued playback and sources.
    if (this.end > now + 0.12 || this.sources.size >= 8) return;
    const frames = pcm.length / 4,
      view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const buffer = this.context.createBuffer(2, frames, 48000);
    for (let channel = 0; channel < 2; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let frame = 0; frame < frames; frame++)
        samples[frame] = view.getInt16(frame * 4 + channel * 2, true) / 32768;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
    };
    this.sources.add(source);
    const at = Math.max(now + 0.02, this.end);
    source.start(at);
    this.end = at + buffer.duration;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const source of this.sources) {
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.gain.disconnect();
    void this.context.close();
  }
}
