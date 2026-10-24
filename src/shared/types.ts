import type { MediaNotice, QualityLimits, VideoFeedback } from './media';
export interface HostEntry {
  id: string;
  name: string;
  url: string;
  fingerprint?: string;
  source: 'discovered' | 'saved' | 'demo';
  sessionOnly?: boolean;
}
export interface Simulator {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  deviceTypeIdentifier?: string;
}
export interface Runtime {
  identifier: string;
  name: string;
  version: string;
  isAvailable: boolean;
  supportedDeviceTypes?: { identifier: string }[];
}
export interface DeviceType {
  identifier: string;
  name: string;
  productFamily?: string;
}
export interface Inventory {
  devices: Simulator[];
  runtimes: Runtime[];
  devicetypes: DeviceType[];
}
export interface HostInfo {
  name: string;
  platform: string;
  version: string;
  protocolVersion?: number;
  clientAuthorization?: boolean;
  companion: boolean;
  xcode: boolean;
}
export interface Probe {
  info: HostInfo;
  certificate: string;
  fingerprint: string;
  url: string;
}
export interface Profile extends HostEntry {
  certificate: string;
  token: string;
}
export type Orientation =
  'PORTRAIT' | 'PORTRAIT_UPSIDE_DOWN' | 'LANDSCAPE_LEFT' | 'LANDSCAPE_RIGHT';
export interface DisplayContext {
  host: HostEntry;
  device: Simulator;
  fps: number;
  sessionActive?: boolean;
}
export type Point = { x: number; y: number };
export type InputEvent =
  | { type: 'touch'; phase: 'down' | 'move' | 'up'; point: Point }
  | { type: 'key'; code: number; phase: 'down' | 'up' }
  | {
      type: 'button';
      button:
        | 'HOME'
        | 'LOCK'
        | 'SIDE_BUTTON'
        | 'SIRI'
        | 'VOLUME_UP'
        | 'VOLUME_DOWN'
        | 'APPLE_PAY'
        | 'EJECT';
      duration?: number;
    }
  | { type: 'pinch'; center: Point; scale: number; duration?: number; radius?: number }
  | { type: 'swipe'; start: Point; end: Point; duration: number }
  | {
      type: 'rotate';
      orientation: 'PORTRAIT' | 'PORTRAIT_UPSIDE_DOWN' | 'LANDSCAPE_LEFT' | 'LANDSCAPE_RIGHT';
    }
  | { type: 'shake' }
  | { type: 'release' };
export interface StreamMeta {
  /** Rotation of the raw surface clockwise, in degrees. Input maps back to surface coordinates. */
  rotation?: 0 | 90 | 180 | 270;
  orientation?: Orientation;
  orientationSource?: 'host' | 'requested' | 'unavailable';
  width: number;
  height: number;
  widthPoints: number;
  heightPoints: number;
}
export interface StreamNotice {
  type: 'metadata' | 'error' | 'closed' | 'status';
  state?: 'connecting' | 'live' | 'retrying' | 'off' | 'failed';
  attempt?: number;
  retryInMs?: number;
  terminal?: boolean;
  code?: string;
  metadata?: StreamMeta;
  message?: string;
}
export interface HostStatus {
  running: boolean;
  url?: string;
  token?: string;
  fingerprint?: string;
  info?: HostInfo;
  addresses?: string[];
}
export interface DesktopApi {
  diagnostics?(hostId?: string): Promise<import('./diagnostics').DiagnosticReport>;
  exportDiagnostics?(report: import('./diagnostics').DiagnosticReport): Promise<boolean>;
  copyText(text: string): Promise<void>;
  hosts(): Promise<HostEntry[]>;
  probe(url: string): Promise<Probe>;
  pair(probe: Probe, token: string): Promise<HostEntry>;
  forget(id: string): Promise<void>;
  request<T>(id: string, method: string, path: string, body?: unknown): Promise<T>;
  connect(id: string, udid: string, fps: number): Promise<void>;
  disconnect(): Promise<void>;
  retry(): Promise<void>;
  popOut(id: string, udid: string, fps: number): Promise<void>;
  displayContext(): Promise<DisplayContext | undefined>;
  returnDisplay(): Promise<void>;
  onReturnDisplay(callback: (context: DisplayContext) => void): () => void;
  windowAction(action: 'maximize' | 'fullscreen'): Promise<void>;
  input(event: InputEvent): void;
  onFrame(callback: (frame: Uint8Array) => void | Promise<void>): () => void;
  onNotice(callback: (notice: StreamNotice) => void): () => void;
  setQuality(limits: QualityLimits): Promise<void>;
  reportVideoFeedback(feedback: VideoFeedback): void;
  startRecording(): Promise<void>;
  stopRecording(): Promise<void>;
  discardRecording(): Promise<void>;
  saveRecording(): Promise<boolean>;
  startAudio(hostAudioConsent: boolean): Promise<void>;
  stopAudio(): Promise<void>;
  onAudio(callback: (pcm: Uint8Array) => void): () => void;
  onMediaNotice(callback: (notice: MediaNotice) => void): () => void;
  hostStatus(): Promise<HostStatus>;
  startHost(): Promise<HostStatus>;
  stopHost(): Promise<void>;
  saveScreenshot(id: string, udid: string): Promise<boolean>;
  installApp(id: string, udid: string): Promise<boolean>;
  platform: string;
}
declare global {
  interface Window {
    relay?: DesktopApi;
  }
}
