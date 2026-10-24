// A deliberately deferred API, injected before the real built React renderer mounts.
const hosts = ['A', 'B'].map((name) => ({
  id: `host-${name}`,
  name: `Hydration Mac ${name}`,
  url: `https://mac-${name}.test:49300`,
  source: 'saved',
}));
const inventory = (name) => ({
  devices: [
    {
      udid: `device-${name}`,
      name: `Hydration Phone ${name}`,
      runtime: 'iOS test',
      state: 'Booted',
    },
  ],
  runtimes: [],
  devicetypes: [],
});
const notices = new Set();
const returns = new Set();
const mediaNotices = new Set();
const calls = [];
const pending = [];
const pendingConnects = [];
let target;
window.hydrationFixture = {
  calls,
  pending,
  pendingConnects,
  manualQuality: () => {
    for (const callback of mediaNotices)
      callback({
        type: 'quality-state',
        limits: { mode: 'manual', maxFps: 15, maxScale: 0.5, quality: 0.6, maxKbps: 1000 },
      });
  },
  advertiseAdaptive: () => {
    for (const callback of mediaNotices)
      callback({
        type: 'media-capabilities',
        capabilities: { adaptive: true, recording: true, audio: false, audioScope: 'host' },
      });
  },
  returnA: () => {
    for (const callback of returns)
      callback({ host: hosts[0], device: inventory('A').devices[0], fps: 30, sessionActive: true });
  },
  failOldConnect: () => {
    for (const reject of pendingConnects.splice(0))
      reject(new Error('Obsolete returned display failed'));
  },
  returnB: () => {
    for (const callback of returns)
      callback({
        host: hosts[1],
        device: inventory('B').devices[0],
        fps: 30,
        sessionActive: false,
      });
  },
  release: (fail = false) => {
    for (const { resolve, reject } of pending.splice(0))
      fail ? reject(new Error('Late host A is offline')) : resolve(inventory('A'));
  },
};
window.relay = {
  platform: 'web',
  workspace: {
    restore: () => ({ hostId: 'host-A', deviceId: 'device-A', fps: 15 }),
    save: (value) => calls.push({ action: 'save', ...value }),
  },
  hosts: async () => hosts,
  request: async (id, method, path, body) => {
    calls.push({ action: 'request', id, method, path, body });
    if (id === 'host-A' && path === '/devices')
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    return path === '/devices' ? inventory('B') : {};
  },
  disconnect: async () => {
    target = undefined;
  },
  connect: async (id, udid, fps) => {
    target = { id, udid };
    calls.push({ action: 'connect', id, udid, fps });
    if (id === 'host-A') return new Promise((_resolve, reject) => pendingConnects.push(reject));
    for (const callback of notices)
      callback({
        type: 'metadata',
        metadata: { width: 400, height: 800, widthPoints: 400, heightPoints: 800 },
      });
  },
  input: (event) => calls.push({ action: 'input', ...target, event }),
  onFrame: () => () => {},
  onMediaNotice: (callback) => {
    mediaNotices.add(callback);
    return () => mediaNotices.delete(callback);
  },
  setQuality: async (limits) => {
    calls.push({ action: 'quality', limits });
  },
  onAudio: () => () => {},
  reportVideoFeedback: () => {},
  displayContext: async () => undefined,
  onReturnDisplay: (callback) => {
    returns.add(callback);
    return () => returns.delete(callback);
  },
  onNotice: (callback) => {
    notices.add(callback);
    return () => notices.delete(callback);
  },
  saveScreenshot: async (id, udid) => {
    calls.push({ action: 'screenshot', id, udid });
    return true;
  },
  hostStatus: async () => ({ running: false }),
};
