import type { HostStatus } from './types';

export interface KeepAwakeStatus {
  enabled: boolean;
  active: boolean;
  activeSessions: number;
  supported: boolean;
  error?: string;
  warning?: string;
}
export interface HostServiceSettings {
  directory: string;
  port: number;
  bind: string;
  companionPath: string;
  hostAudio: boolean;
  audioHelper: string;
  startAtLogin: boolean;
}
export interface HostManagementStatus {
  state: 'stopped' | 'starting' | 'ready' | 'unhealthy' | 'failed';
  mode: 'background' | 'foreground' | 'none';
  observedAt: string;
  registered: boolean;
  pid?: number;
  settings: HostServiceSettings;
  host?: Omit<HostStatus, 'token'>;
  keepAwake?: KeepAwakeStatus;
  message?: string;
}
export type HostServiceAction = 'start' | 'stop' | 'restart';
