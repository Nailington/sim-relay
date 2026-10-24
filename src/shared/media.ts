/** Additive media protocol; JPEG messages remain wire-compatible with older clients. */
export interface QualityLimits {
  mode: 'auto' | 'manual';
  maxFps: number;
  maxScale: number;
  quality: number;
  maxKbps: number;
}
export interface VideoSettings {
  fps: number;
  scale: number;
  quality: number;
}
export interface VideoFeedback {
  decoded: number;
  dropped: number;
  decodeMs: number;
  intervalMs: number;
}
export interface StreamMetrics {
  kbps: number;
  sentFps: number;
  decodedFps?: number;
  dropped: number;
  decodeMs?: number;
  /** Host-send to client acknowledgement round trip; NOT capture-to-display latency. */
  roundTripMs?: number;
  settings: VideoSettings;
  mode: QualityLimits['mode'];
}
export interface MediaCapabilities {
  recording: boolean;
  audio: boolean;
  audioScope: 'host';
  audioReason?: string;
  adaptive: boolean;
}
export interface RecordingStatus {
  phase: 'idle' | 'starting' | 'recording' | 'finalizing' | 'ready' | 'saving' | 'error';
  startedAt?: number;
  bytes?: number;
  message?: string;
}
export interface RecordingDownload {
  id: string;
  ticket: string;
  bytes: number;
}
export type MediaAction =
  'recording-start' | 'recording-stop' | 'recording-discard' | 'audio-start' | 'audio-stop';
export type MediaNotice =
  | { type: 'media-capabilities'; capabilities: MediaCapabilities }
  | { type: 'media-result'; id: string; result?: RecordingDownload; error?: string }
  | { type: 'recording'; recording: RecordingStatus }
  | { type: 'audio'; active: boolean; message?: string }
  | { type: 'metrics'; metrics: StreamMetrics };
export const defaultQuality = (maxFps = 30): QualityLimits => ({
  mode: 'auto',
  maxFps,
  maxScale: 1,
  quality: 0.7,
  maxKbps: 12000,
});
