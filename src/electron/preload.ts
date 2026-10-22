import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../shared/types';
const api: DesktopApi = {
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  platform: process.platform,
  hosts: () => ipcRenderer.invoke('hosts'),
  probe: (url) => ipcRenderer.invoke('probe', url),
  pair: (probe, token) => ipcRenderer.invoke('pair', probe, token),
  forget: (id) => ipcRenderer.invoke('forget', id),
  request: (id, method, path, body) => ipcRenderer.invoke('request', id, method, path, body),
  connect: (id, udid, fps) => ipcRenderer.invoke('connect', id, udid, fps),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  input: (event) => ipcRenderer.send('input', event),
  onFrame: (callback) => {
    const listener = (_event: unknown, data: Uint8Array) => callback(data);
    ipcRenderer.on('frame', listener);
    return () => ipcRenderer.removeListener('frame', listener);
  },
  onNotice: (callback) => {
    const listener = (
      _event: unknown,
      notice: Parameters<Parameters<DesktopApi['onNotice']>[0]>[0],
    ) => callback(notice);
    ipcRenderer.on('notice', listener);
    return () => ipcRenderer.removeListener('notice', listener);
  },
  hostStatus: () => ipcRenderer.invoke('host-status'),
  startHost: () => ipcRenderer.invoke('start-host'),
  stopHost: () => ipcRenderer.invoke('stop-host'),
  saveScreenshot: (id, udid) => ipcRenderer.invoke('save-screenshot', id, udid),
  installApp: (id, udid) => ipcRenderer.invoke('install-app', id, udid),
};
contextBridge.exposeInMainWorld('relay', api);
