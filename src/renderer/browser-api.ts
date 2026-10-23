import type {
  DesktopApi,
  Profile,
  Probe,
  HostEntry,
  InputEvent,
  StreamNotice,
} from '../shared/types';

export const browserStorageKey = (user: string) => `sim-relay.web.v1.${encodeURIComponent(user)}`;
async function storageMutation<T>(key: string, action: () => T): Promise<T> {
  if (navigator.locks) return navigator.locks.request(key, action);
  return action();
}
export async function clearBrowserWorkspace(user: string): Promise<void> {
  const key = browserStorageKey(user);
  await storageMutation(key, () => {
    localStorage.removeItem(key);
    localStorage.removeItem(key + '.preferences');
  });
}
export async function webCall<T>(action: string, data?: unknown): Promise<T> {
  const response = await fetch(`/api/${action}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data ?? {}),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(
      result.error ?? 'The hosting service did not respond. Sign in again or check its connection.',
    );
  }
  return response.json();
}
const publicProfile = ({
  token: _token,
  certificate: _certificate,
  ...value
}: Profile): HostEntry => value;
function download(data: Blob, filename: string) {
  const url = URL.createObjectURL(data),
    link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** One transport per tab; saved profiles are local to this signed-in user and browser. */
export function createBrowserApi(user: string): DesktopApi {
  const key = browserStorageKey(user);
  const readProfiles = (): Profile[] => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
      if (!Array.isArray(value)) return [];
      return value.filter(
        (entry): entry is Profile =>
          entry &&
          typeof entry.id === 'string' &&
          typeof entry.name === 'string' &&
          typeof entry.url === 'string' &&
          typeof entry.token === 'string' &&
          typeof entry.certificate === 'string' &&
          typeof entry.fingerprint === 'string' &&
          entry.source === 'saved',
      );
    } catch {
      return [];
    }
  };
  const save = (profiles: Profile[]) => {
    try {
      localStorage.setItem(key, JSON.stringify(profiles));
    } catch {
      throw new Error(
        'Browser storage is unavailable or full. Allow storage for this site before pairing.',
      );
    }
  };
  const get = (id: string) => {
    const value = readProfiles().find((profile) => profile.id === id);
    if (!value) throw new Error('Pair with this Mac in this browser first.');
    return value;
  };
  let socket: WebSocket | undefined,
    generation = 0;
  let connectedProfile: Profile | undefined;
  const frames = new Set<(frame: Uint8Array) => void>();
  const notices = new Set<(notice: StreamNotice) => void>();
  const notify = (notice: StreamNotice) => {
    for (const listener of notices) listener(notice);
  };
  const disconnect = async () => {
    generation++;
    const old = socket;
    socket = undefined;
    connectedProfile = undefined;
    old?.close();
    notify({ type: 'closed' });
  };
  const requestBlob = async (id: string, path: string) => {
    const response = await fetch('/api/request', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: get(id), method: 'GET', path }),
    });
    if (!response.ok)
      throw new Error(
        'The screenshot could not be downloaded. Check the Mac connection and retry.',
      );
    return response.blob();
  };
  const api: DesktopApi = {
    workspace: {
      restore: () => {
        try {
          const value = JSON.parse(localStorage.getItem(key + '.preferences') ?? '{}');
          if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
          return {
            hostId: typeof value.hostId === 'string' ? value.hostId : undefined,
            deviceId: typeof value.deviceId === 'string' ? value.deviceId : undefined,
            fps: [15, 30, 60].includes(value.fps) ? value.fps : undefined,
          };
        } catch {
          return {};
        }
      },
      save: (value) => {
        localStorage.setItem(key + '.preferences', JSON.stringify(value));
      },
    },
    platform: 'web',
    copyText: (text) => navigator.clipboard.writeText(text),
    hosts: async () => readProfiles().map(publicProfile),
    probe: (url) => webCall<Probe>('probe', { url }),
    pair: async (probe, token) => {
      const previous = readProfiles().find((profile) => profile.url === probe.url);
      const proposed: Profile = {
        id: previous?.id ?? crypto.randomUUID(),
        name: probe.info.name,
        url: probe.url,
        fingerprint: probe.fingerprint,
        certificate: probe.certificate,
        token,
        source: 'saved',
      };
      const paired = await webCall<Profile>('pair', { profile: proposed });
      // Reconcile after the asynchronous exchange: another tab may have reset or changed storage.
      await storageMutation(key, () =>
        save(
          readProfiles()
            .filter((profile) => profile.id !== paired.id)
            .concat(paired),
        ),
      );
      return publicProfile(paired);
    },
    forget: async (id) => {
      if (connectedProfile?.id === id) await disconnect();
      await storageMutation(key, () => save(readProfiles().filter((profile) => profile.id !== id)));
    },
    request: (id, method, path, body) =>
      webCall('request', { profile: get(id), method, path, body }),
    connect: async (id, udid, fps) => {
      await disconnect();
      connectedProfile = get(id);
      const attempt = ++generation;
      const url = new URL('/api/stream', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const current = new WebSocket(url);
      current.binaryType = 'arraybuffer';
      socket = current;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          current.close();
          reject(new Error('The Mac did not start streaming. Check its connection and retry.'));
        }, 20_000);
        let started = false;
        current.onopen = () =>
          current.send(JSON.stringify({ profile: connectedProfile, udid, fps }));
        current.onmessage = (event) => {
          if (generation !== attempt || socket !== current) return;
          if (typeof event.data !== 'string') {
            for (const callback of frames) callback(new Uint8Array(event.data));
            return;
          }
          try {
            const notice: StreamNotice = JSON.parse(event.data);
            notify(notice);
            if (notice.type === 'metadata') {
              started = true;
              clearTimeout(timer);
              resolve();
            }
            if (notice.type === 'error' && !started) {
              clearTimeout(timer);
              reject(new Error(notice.message));
            }
          } catch {
            current.close();
          }
        };
        current.onerror = () => {
          clearTimeout(timer);
          if (!started)
            reject(
              new Error('Cannot reach the hosting service. Check its connection or sign in again.'),
            );
        };
        current.onclose = () => {
          clearTimeout(timer);
          if (!started)
            reject(
              new Error(
                'Display connection closed. Check pairing and simulator state, then retry.',
              ),
            );
          if (socket === current) {
            socket = undefined;
            connectedProfile = undefined;
            notify({ type: 'closed' });
          }
        };
      });
    },
    disconnect,
    input: (event: InputEvent) => {
      if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 64 * 1024)
        socket.send(JSON.stringify(event));
    },
    onFrame: (callback) => {
      frames.add(callback);
      return () => frames.delete(callback);
    },
    onNotice: (callback) => {
      notices.add(callback);
      return () => notices.delete(callback);
    },
    hostStatus: async () => ({ running: false }),
    startHost: async () => {
      throw new Error(
        'Start the host service directly on your Mac. A browser cannot share simulators.',
      );
    },
    stopHost: async () => {
      throw new Error('Stop sharing directly on your Mac.');
    },
    saveScreenshot: async (id, udid) => {
      download(await requestBlob(id, `/devices/${udid}/screenshot`), `Simulator-${Date.now()}.png`);
      return true;
    },
    installApp: async (id, udid) => {
      const file = document.createElement('input');
      file.type = 'file';
      file.accept = '.zip';
      const selected = await new Promise<File | undefined>((resolve) => {
        file.onchange = () => resolve(file.files?.[0]);
        file.oncancel = () => resolve(undefined);
        file.click();
      });
      if (!selected) return false;
      if (selected.size > 128 * 1024 * 1024)
        throw new Error('Choose an app archive smaller than 128 MB.');
      const encoded = btoa(
        String.fromCharCode(...new TextEncoder().encode(JSON.stringify(get(id)))),
      );
      const response = await fetch('/api/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Sim-Relay-Profile': encoded, 'X-Sim-Relay-Device': udid },
        body: selected,
      });
      if (!response.ok)
        throw new Error(
          'The app could not be installed. Choose a simulator .app.zip archive and check the Mac connection.',
        );
      return true;
    },
  };
  const release = () => {
    // Current hosts support release; older hosts receive the explicit UP events from DeviceStage.
    if (document.visibilityState === 'hidden') void disconnect();
  };
  document.addEventListener('visibilitychange', release);
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== key) return;
    if (!connectedProfile) return;
    const current = readProfiles().find((entry) => entry.id === connectedProfile!.id);
    if (
      !current ||
      current.token !== connectedProfile.token ||
      current.fingerprint !== connectedProfile.fingerprint
    ) {
      void disconnect();
      notify({
        type: 'error',
        message:
          'This browser’s saved pairing changed in another tab. Select a saved Mac or pair again.',
      });
    }
  });
  window.addEventListener('pagehide', () => void disconnect(), { once: true });
  return api;
}
