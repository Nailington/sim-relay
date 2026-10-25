import { recordingGuard, invalidateRecordingProtection } from './recording-guard';
import { RecordingActionCancelled } from '../shared/recording-protection';
import type { DesktopApi, Profile, Probe, HostEntry, StreamNotice } from '../shared/types';
import { browserSession } from './browser-session';
import { browserDisplays } from './browser-displays';
import { browserRecording } from './browser-recording';
import { createDiagnostics } from '../electron/diagnostics';
import { serializeReport } from '../shared/diagnostics';
import metadata from '../../package.json';
import {
  announceBrowserAccount,
  createBrowserAccount,
  type BrowserAccount,
} from './browser-account';

const lifetimes = new WeakMap<DesktopApi, () => void>();
const accounts = new WeakMap<DesktopApi, BrowserAccount>();
export function disposeBrowserApi(api?: DesktopApi) {
  if (api) {
    invalidateRecordingProtection(api);
    lifetimes.get(api)?.();
    lifetimes.delete(api);
  }
}
export async function signOutBrowserApi(api: DesktopApi) {
  const account = accounts.get(api);
  if (!account) throw new Error('Open this workspace again to sign out.');
  await account.verify();
  if (!(await recordingGuard(api).confirm('Sign out'))) throw new RecordingActionCancelled();
  account.assertCurrent();
  announceBrowserAccount();
  await webCall('logout', {}, account.user);
  disposeBrowserApi(api);
}
export async function resetBrowserApi(api: DesktopApi) {
  const account = accounts.get(api);
  if (!account) throw new Error('Open this workspace again before clearing its saved setup.');
  await account.verify();
  if (!(await recordingGuard(api).confirm('Clear saved setup')))
    throw new RecordingActionCancelled();
  account.assertCurrent();
  await api.disconnect();
  account.assertCurrent();
  await clearBrowserWorkspace(account.user);
}
export const browserStorageKey = (user: string) => `sim-relay.web.v1.${encodeURIComponent(user)}`;
async function storageMutation<T>(key: string, action: () => T): Promise<T> {
  if (navigator.locks) return navigator.locks.request(key, action);
  return action();
}
export async function clearBrowserWorkspace(user: string): Promise<void> {
  const key = browserStorageKey(user);
  await storageMutation(key, () => {
    localStorage.setItem(key + '.reset', crypto.randomUUID());
    localStorage.removeItem(key);
    localStorage.removeItem(key + '.preferences');
  });
}
class BrowserAuthorizationRequired extends Error {}
export async function webCall<T>(
  action: string,
  data?: unknown,
  user?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/${action}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(user !== undefined ? { 'X-Sim-Relay-User': encodeURIComponent(user) } : {}),
    },
    body: JSON.stringify(data ?? {}),
    signal,
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    const Failure = response.status === 401 ? BrowserAuthorizationRequired : Error;
    throw new Failure(
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
export function createBrowserApi(user: string, onInvalidated?: () => void): DesktopApi {
  const lifetime = new AbortController();
  let stop = () => {};
  const account = createBrowserAccount(user, lifetime.signal, () => {
    invalidateRecordingProtection(api);
    stop();
    lifetime.abort();
    onInvalidated?.();
  });
  const key = browserStorageKey(user);
  const resetRevision = () => localStorage.getItem(key + '.reset');
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
    account.assertCurrent();
    const value = readProfiles().find((profile) => profile.id === id);
    if (!value) throw new Error('Pair with this Mac in this browser first.');
    return value;
  };
  const notices = new Set<(notice: StreamNotice) => void>();
  const notify = (notice: StreamNotice) => {
    for (const listener of notices) listener(notice);
  };
  const transport = browserSession(get, notify, account, resetRevision);
  const { session, media } = transport;
  stop = () => session.disconnect();
  const call = async <T>(action: string, data: () => unknown): Promise<T> => {
    await account.verify();
    try {
      const result = await webCall<T>(action, data(), user, lifetime.signal);
      account.assertCurrent();
      return result;
    } catch (error) {
      if (error instanceof BrowserAuthorizationRequired) account.invalidate();
      throw error;
    }
  };
  const disconnect = async () => {
    session.disconnect();
  };
  const saveRecording = browserRecording(media, transport.profile, (profile, recording) =>
    call('recording-download', () => ({ profile: get(profile.id), recording })),
  );
  const diagnostics = createDiagnostics({
    version: metadata.version,
    platform: 'browser',
    profile: get,
    probe: (url) => call<Probe>('probe', () => ({ url })),
    inventory: (profile) =>
      call('request', () => ({ profile: get(profile.id), method: 'GET', path: '/devices' })),
  });
  const requestBlob = async (id: string, path: string) => {
    await account.verify();
    const response = await fetch('/api/request', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Sim-Relay-User': encodeURIComponent(user) },
      body: JSON.stringify({ profile: get(id), method: 'GET', path }),
      signal: lifetime.signal,
    });
    account.assertCurrent();
    if (response.status === 401) account.invalidate();
    if (!response.ok)
      throw new Error(
        'The screenshot could not be downloaded. Check the Mac connection and retry.',
      );
    const blob = await response.blob();
    account.assertCurrent();
    return blob;
  };
  const api: DesktopApi = {
    workspace: {
      restore: () => {
        try {
          account.assertCurrent();
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
        account.assertCurrent();
        localStorage.setItem(key + '.preferences', JSON.stringify(value));
      },
    },
    platform: 'web',
    copyText: (text) => {
      account.assertCurrent();
      return navigator.clipboard.writeText(text);
    },
    hosts: async () => {
      await account.verify();
      return readProfiles().map(publicProfile);
    },
    probe: (url) => call<Probe>('probe', () => ({ url })),
    pair: async (probe, token) => {
      account.assertCurrent();
      const reset = resetRevision();
      const stillPairing = () => {
        account.assertCurrent();
        if (reset !== resetRevision())
          throw new Error(
            'Saved setup was cleared while pairing. Start pairing again to save this Mac.',
          );
      };
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
      const paired = await call<Profile>('pair', () => ({ profile: proposed }));
      stillPairing();
      // Reconcile after the asynchronous exchange: another tab may have reset or changed storage.
      await storageMutation(key, () => {
        stillPairing();
        save(
          readProfiles()
            .filter((profile) => profile.id !== paired.id)
            .concat(paired),
        );
      });
      return publicProfile(paired);
    },
    forget: async (id) => {
      await account.verify();
      if (session.target?.hostId === id) await disconnect();
      await storageMutation(key, () => {
        account.assertCurrent();
        save(readProfiles().filter((profile) => profile.id !== id));
      });
    },
    request: (id, method, path, body) =>
      call('request', () => ({ profile: get(id), method, path, body })),
    connect: (id, udid, fps) => {
      account.assertCurrent();
      return session.connect({ hostId: id, udid, fps });
    },
    disconnect,
    retry: () => {
      account.assertCurrent();
      return session.retry();
    },
    input: (event) => {
      if (!account.isCurrent()) {
        account.invalidate();
        return;
      }
      session.input(event);
    },
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
    diagnostics: async (id) => {
      await account.verify();
      return diagnostics.refresh(id).then((report) => {
        account.assertCurrent();
        return { ...report, client: { ...report.client, platform: 'browser' } };
      });
    },
    exportDiagnostics: async (report) => {
      account.assertCurrent();
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
      account.assertCurrent();
      const file = document.createElement('input');
      file.type = 'file';
      file.accept = '.zip';
      const selected = await new Promise<File | undefined>((resolve) => {
        file.onchange = () => resolve(file.files?.[0]);
        file.oncancel = () => resolve(undefined);
        file.click();
      });
      if (!selected) return false;
      await account.verify();
      if (selected.size > 128 * 1024 * 1024)
        throw new Error('Choose an app archive smaller than 128 MB.');
      const encoded = btoa(
        String.fromCharCode(...new TextEncoder().encode(JSON.stringify(get(id)))),
      );
      const response = await fetch('/api/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'X-Sim-Relay-User': encodeURIComponent(user),
          'X-Sim-Relay-Profile': encoded,
          'X-Sim-Relay-Device': udid,
        },
        body: selected,
        signal: lifetime.signal,
      });
      account.assertCurrent();
      if (response.status === 401) account.invalidate();
      if (!response.ok)
        throw new Error(
          'The app could not be installed. Choose a simulator .app.zip archive and check the Mac connection.',
        );
      return true;
    },
  };
  accounts.set(api, account);
  lifetimes.set(api, () => {
    session.disconnect();
    lifetime.abort();
  });
  const release = () => {
    // Current hosts support release; older hosts receive the explicit UP events from DeviceStage.
    if (document.visibilityState === 'hidden') session.input({ type: 'release' });
  };
  document.addEventListener('visibilitychange', release, { signal: lifetime.signal });
  window.addEventListener(
    'storage',
    (event) => {
      if (event.key !== null && event.key !== key && event.key !== key + '.reset') return;
      const connectedProfile = transport.profile();
      if (!connectedProfile) return;
      const current = readProfiles().find((entry) => entry.id === connectedProfile.id);
      if (
        event.key === key + '.reset' ||
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
