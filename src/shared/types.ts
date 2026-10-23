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
  | { type: 'shake' };
export interface StreamMeta {
  width: number;
  height: number;
  widthPoints: number;
  heightPoints: number;
}
export interface StreamNotice {
  type: 'metadata' | 'error' | 'closed';
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
  copyText(text: string): Promise<void>;
  hosts(): Promise<HostEntry[]>;
  probe(url: string): Promise<Probe>;
  pair(probe: Probe, token: string): Promise<HostEntry>;
  forget(id: string): Promise<void>;
  request<T>(id: string, method: string, path: string, body?: unknown): Promise<T>;
  connect(id: string, udid: string, fps: number): Promise<void>;
  disconnect(): Promise<void>;
  input(event: InputEvent): void;
  onFrame(callback: (frame: Uint8Array) => void): () => void;
  onNotice(callback: (notice: StreamNotice) => void): () => void;
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
