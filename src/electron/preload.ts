import { contextBridge, ipcRenderer } from 'electron';
import type { MediaNotice } from '../shared/media';
import type { DesktopApi } from '../shared/types';
const frameListeners = new Set<Parameters<DesktopApi['onFrame']>[0]>();
const audioListeners = new Set<Parameters<DesktopApi['onAudio']>[0]>();
// Always acknowledge even before a display has mounted its decoder.
ipcRenderer.on('frame', (_event, data: Uint8Array) => {
  void Promise.allSettled(
    [...frameListeners].map((callback) => Promise.resolve().then(() => callback(data))),
  ).finally(() => ipcRenderer.send('video-consumed'));
});
ipcRenderer.on('audio-frame', (_event, data: Uint8Array) => {
  try {
    for (const callback of audioListeners) callback(data);
  } finally {
    ipcRenderer.send('audio-consumed');
  }
});
const mediaListeners = new Set<(notice: MediaNotice) => void>();
const mediaNotices = new Map<string, MediaNotice>();
ipcRenderer.on('media-notice', (_event, notice: MediaNotice) => {
  mediaNotices.set(notice.type, notice);
  for (const callback of mediaListeners) callback(notice);
});
ipcRenderer.on('notice', (_event, notice) => {
  if (notice.type === 'status' && ['off', 'failed', 'connecting'].includes(notice.state))
    mediaNotices.clear();
});
const api: DesktopApi = {
  updatePreferencesKey: 'sim-relay.updates.v1',
  checkUpdates: (channel) => ipcRenderer.invoke('check-updates', channel),
  openUpdateLink: (url) => ipcRenderer.invoke('open-update-link', url),
  diagnostics: (id) => ipcRenderer.invoke('diagnostics', id),
  exportDiagnostics: (report) => ipcRenderer.invoke('export-diagnostics', report),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  platform: process.platform,
  hosts: () => ipcRenderer.invoke('hosts'),
  probe: (url) => ipcRenderer.invoke('probe', url),
  pair: (probe, token) => ipcRenderer.invoke('pair', probe, token),
  forget: (id) => ipcRenderer.invoke('forget', id),
  request: (id, method, path, body) => ipcRenderer.invoke('request', id, method, path, body),
  connect: (id, udid, fps) => ipcRenderer.invoke('connect', id, udid, fps),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  retry: () => ipcRenderer.invoke('retry'),
  popOut: (id, udid, fps) => ipcRenderer.invoke('pop-out', id, udid, fps),
  displayContext: () => ipcRenderer.invoke('display-context'),
  returnDisplay: () => ipcRenderer.invoke('return-display'),
  windowAction: (action) => ipcRenderer.invoke('window-action', action),
  onReturnDisplay: (callback) => {
    const listener = (
      _event: unknown,
      context: Parameters<Parameters<DesktopApi['onReturnDisplay']>[0]>[0],
    ) => callback(context);
    ipcRenderer.on('return-display', listener);
    return () => ipcRenderer.removeListener('return-display', listener);
  },
  input: (event) => ipcRenderer.send('input', event),
  onFrame: (callback) => {
    frameListeners.add(callback);
    return () => {
      frameListeners.delete(callback);
    };
  },
  setQuality: (limits) => ipcRenderer.invoke('media-quality', limits),
  reportVideoFeedback: (feedback) => ipcRenderer.send('video-feedback', feedback),
  startRecording: () => ipcRenderer.invoke('media-command', 'recording-start'),
  stopRecording: () => ipcRenderer.invoke('media-command', 'recording-stop'),
  discardRecording: () => ipcRenderer.invoke('media-command', 'recording-discard'),
  saveRecording: () => ipcRenderer.invoke('save-recording'),
  startAudio: (consent) => ipcRenderer.invoke('media-command', 'audio-start', consent),
  stopAudio: () => ipcRenderer.invoke('media-command', 'audio-stop'),
  onAudio: (callback) => {
    audioListeners.add(callback);
    return () => {
      audioListeners.delete(callback);
    };
  },
  onMediaNotice: (callback) => {
    mediaListeners.add(callback);
    queueMicrotask(() => {
      if (mediaListeners.has(callback))
        for (const notice of mediaNotices.values()) callback(notice);
    });
    return () => {
      mediaListeners.delete(callback);
    };
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
