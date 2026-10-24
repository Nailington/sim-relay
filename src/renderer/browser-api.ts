import type { DesktopApi, Profile, Probe, HostEntry, StreamNotice } from '../shared/types';
import { browserSession } from './browser-session';
import { browserDisplays } from './browser-displays';
import { browserRecording } from './browser-recording';
import { createDiagnostics } from '../electron/diagnostics';
import { serializeReport } from '../shared/diagnostics';
import metadata from '../../package.json';

const lifetimes = new WeakMap<DesktopApi, () => void>();
export function disposeBrowserApi(api?: DesktopApi) {
  if (api) {
    lifetimes.get(api)?.();
    lifetimes.delete(api);
  }
}
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
  const lifetime = new AbortController();
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
  const notices = new Set<(notice: StreamNotice) => void>();
  const notify = (notice: StreamNotice) => {
    for (const listener of notices) listener(notice);
  };
  const transport = browserSession(get, notify);
  const { session, media } = transport;
  const disconnect = async () => {
    session.disconnect();
  };
  const saveRecording = browserRecording(media, transport.profile, (profile, recording) =>
    webCall('recording-download', { profile, recording }),
  );
  const diagnostics = createDiagnostics({
    version: metadata.version,
    platform: 'browser',
    profile: get,
    probe: (url) => webCall<Probe>('probe', { url }),
    inventory: (profile) => webCall('request', { profile, method: 'GET', path: '/devices' }),
  });
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
      if (session.target?.hostId === id) await disconnect();
      await storageMutation(key, () => save(readProfiles().filter((profile) => profile.id !== id)));
    },
    request: (id, method, path, body) =>
      webCall('request', { profile: get(id), method, path, body }),
    connect: (id, udid, fps) => session.connect({ hostId: id, udid, fps }),
    disconnect,
    retry: () => session.retry(),
    input: (event) => session.input(event),
    onFrame: (callback) => {
      media.frames.add(callback);
      return () => {
        media.frames.delete(callback);
      };
    },
    setQuality: async (limits) => media.quality(limits),
    reportVideoFeedback: (feedback) => {
      if (session.active)
        try {
          media.feedback(feedback);
        } catch {
          /* A closing transport skips feedback. */
        }
    },
    startRecording: async () => {
      await media.command('recording-start');
    },
    stopRecording: async () => {
      await media.command('recording-stop');
    },
    discardRecording: async () => {
      await media.command('recording-discard');
    },
    saveRecording,
    startAudio: async (consent) => {
      await media.command('audio-start', consent);
    },
    stopAudio: async () => {
      await media.command('audio-stop');
    },
    onAudio: (callback) => {
      media.audio.add(callback);
      return () => {
        media.audio.delete(callback);
      };
    },
    onMediaNotice: (callback) => media.subscribe(callback),
    diagnostics: (id) =>
      diagnostics
        .refresh(id)
        .then((report) => ({ ...report, client: { ...report.client, platform: 'browser' } })),
    exportDiagnostics: async (report) => {
      download(
        new Blob([serializeReport(report)], { type: 'application/json' }),
        `Sim-Relay-diagnostics-${Date.now()}.json`,
      );
      return true;
    },
    ...browserDisplays(
      () => api,
      () => session.active,
      lifetime.signal,
    ),
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
  lifetimes.set(api, () => {
    session.disconnect();
    lifetime.abort();
  });
  const release = () => {
    // Current hosts support release; older hosts receive the explicit UP events from DeviceStage.
    if (document.visibilityState === 'hidden') void disconnect();
  };
  document.addEventListener('visibilitychange', release, { signal: lifetime.signal });
  window.addEventListener(
    'storage',
    (event) => {
      if (event.key !== null && event.key !== key) return;
      const connectedProfile = transport.profile();
      if (!connectedProfile) return;
      const current = readProfiles().find((entry) => entry.id === connectedProfile.id);
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
    },
    { signal: lifetime.signal },
  );
  window.addEventListener('pagehide', () => disposeBrowserApi(api), {
    once: true,
    signal: lifetime.signal,
  });
  return api;
}
