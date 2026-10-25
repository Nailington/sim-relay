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

export interface HostClientPermissions {
  role: 'viewer' | 'controller';
  devices: 'all' | string[];
  installation: boolean;
  destructive: boolean;
  rawSimctl: boolean;
  screenshots: boolean;
  recordings: boolean;
  hostAudio: boolean;
}
export interface HostAuthorizedClient {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt?: string;
  activeSessions: number;
  permissions: HostClientPermissions;
  permissionRevision: number;
}
export interface HostManagementApi {
  status(): Promise<HostManagementStatus>;
  action(action: HostServiceAction): Promise<HostManagementStatus>;
  saveSettings(settings: HostServiceSettings): Promise<HostManagementStatus>;
  setLogin(enabled: boolean): Promise<HostManagementStatus>;
  keepAwake(enabled: boolean): Promise<void>;
  pairing(): Promise<{ token: string; fingerprint: string }>;
  copyPairing(): Promise<void>;
  clients(): Promise<HostAuthorizedClient[]>;
  revoke(id: string): Promise<void>;
  permissions(
    id: string,
    expectedRevision: number,
    permissions: HostClientPermissions,
  ): Promise<HostAuthorizedClient>;
}
