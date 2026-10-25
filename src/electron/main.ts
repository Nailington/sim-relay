import { RecordingActionCancelled, requestMayLoseRecording } from '../shared/recording-protection';
import { recordingCloseProtection } from './recording-close';
import { app, BrowserWindow, ipcMain, safeStorage, dialog, Menu, clipboard, shell } from 'electron';
import { Bonjour } from 'bonjour-service';
import { WebSocket } from 'ws';
import { randomUUID, X509Certificate } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { hostname } from 'node:os';
import {
  hostUrl,
  probeHost,
  remoteRequest,
  tlsOptions,
  pairRemoteClient,
  selectMacRoute,
  verifyMacAddress,
} from './remote';
import { discoveredMacs, editMacAddress, macAddresses, publicMac } from '../shared/mac-routes';
import { createServiceManager } from '../host/service-manager';
import { registerHostManagement } from './host-management';
import { installHostCommand } from './host-command';
import { createDiagnostics } from './diagnostics';
import { serializeReport, type DiagnosticStage } from '../shared/diagnostics';
import { ClientMedia } from './media';
import type { MediaAction, QualityLimits } from '../shared/media';
import { inputSchema } from '../host/protocol';
import { RelaySession, SessionFailure, SessionRouter } from './session';
import { parseHostInfo } from '../shared/host-info';
import { createUpdateChecker } from '../shared/update-checker';
import { releaseLink } from '../shared/updates';
import type {
  DisplayContext,
  HostEntry,
  Profile,
  Probe,
  HostStatus,
  Inventory,
} from '../shared/types';

let window: BrowserWindow;
let workspaceContext: DisplayContext | undefined;
// Window loading yields to other IPC calls. Serialize ownership changes through completion.
let ownershipTail: Promise<unknown> = Promise.resolve();
const canceledSelections = new Map<number, number>();
let discovery: Bonjour | undefined;
const windows = new Map<number, BrowserWindow>();
const displays = new Map<number, DisplayContext>();
const sessions = new SessionRouter<number, RelaySession>();
const identities = new WeakMap<RelaySession, DisplayContext>();
const mediaBySession = new WeakMap<RelaySession, ClientMedia>();
const hostService = createServiceManager({
  launch: {
    args: [
      process.execPath,
      app.isPackaged
        ? path.join(process.resourcesPath, 'host/host.cjs')
        : path.resolve(__dirname, '../dist-host/host.cjs'),
      'serve',
    ],
    workingDirectory: app.getPath('home'),
  },
});
const profiles = new Map<string, Profile>(),
  discovered = new Map<string, HostEntry>();
let secureStorageAvailable = false;
const publicProfile = publicMac;
const profile = (id: string) => {
  const result = profiles.get(id);
  if (!result) throw new Error('Pair with this Mac first.');
  return result;
};
const diagnostics = createDiagnostics({
  version: app.getVersion(),
  platform: process.platform,
  profile,
  prepare: selectMacRoute,
  probe: probeHost,
  inventory: async (entry) =>
    JSON.parse((await remoteRequest(entry, 'GET', '/devices', undefined, 10000)).toString()),
});
function actionStage(channel: string, args: unknown[]): DiagnosticStage | undefined {
  if (channel === 'probe') return 'network';
  if (['save-screenshot', 'install-app'].includes(channel)) return 'action';
  if (channel === 'pair') return 'authentication';
  if (channel === 'connect') return 'stream';
  if (channel === 'request')
    return String(args[2]).endsWith('/boot')
      ? 'boot'
      : args[2] === '/devices' && args[1] === 'GET'
        ? 'runtimes'
        : 'action';
}
async function saveProfiles() {
  if (!secureStorageAvailable) return false;
  try {
    const entries = await Promise.all(
      [...profiles.values()].map(async (p) => ({
        ...p,
        currentRoute: undefined,
        sessionOnly: false,
        token: (await safeStorage.encryptStringAsync(p.token)).toString('base64'),
      })),
    );
    await writeFile(path.join(app.getPath('userData'), 'hosts.json'), JSON.stringify(entries), {
      mode: 0o600,
    });
    for (const p of profiles.values()) p.sessionOnly = false;
    return true;
  } catch {
    // A locked or unavailable keychain must not prevent an in-memory connection.
    secureStorageAvailable = false;
    return false;
  }
}
function windowHasUnsavedRecording(owner: BrowserWindow) {
  const session = sessions.get(owner.id);
  return !!session && !!mediaBySession.get(session)?.hasUnsavedRecording;
}
const recordingClose = recordingCloseProtection(windowHasUnsavedRecording);
async function protectRecordingOwners(action: string, hostId?: string, udid?: string) {
  const owners = () =>
    [...windows.values()].filter(
      (owner) =>
        (!hostId || sessions.get(owner.id)?.target?.hostId === hostId) &&
        (!udid || sessions.get(owner.id)?.target?.udid === udid),
    );
  if (
    !(await recordingClose.confirmOwners(owners(), action)) ||
    owners().some(windowHasUnsavedRecording)
  )
    throw new RecordingActionCancelled();
}
function disconnect(owner: BrowserWindow) {
  canceledSelections.set(owner.id, (canceledSelections.get(owner.id) ?? 0) + 1);
  const session = sessions.get(owner.id);
  session?.disconnect();
  return session ? (mediaBySession.get(session)?.close() ?? Promise.resolve()) : Promise.resolve();
}
function handle(channel: string, fn: (...args: any[]) => unknown, withWindow = false) {
  ipcMain.handle(channel, async (event, ...args) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || !windows.has(owner.id) || event.senderFrame !== owner.webContents.mainFrame)
      throw new Error('Unknown app window.');
    const stage = actionStage(channel, args);
    const hostId =
      ['connect', 'request', 'save-screenshot', 'install-app'].includes(channel) &&
      typeof args[0] === 'string'
        ? args[0]
        : undefined;
    try {
      const generation = canceledSelections.get(owner.id) ?? 0;
      const invoke = () => {
        if (owner.isDestroyed() || !windows.has(owner.id))
          throw new Error('This display was closed.');
        if (
          ['connect', 'retry'].includes(channel) &&
          generation !== (canceledSelections.get(owner.id) ?? 0)
        )
          throw new Error('Connection canceled.');
        return withWindow ? fn(owner, ...args) : fn(...args);
      };
      let result: unknown;
      if (['connect', 'retry', 'pop-out', 'return-display'].includes(channel)) {
        const operation = ownershipTail.then(invoke);
        ownershipTail = operation.catch(() => {});
        result = await operation;
      } else result = await invoke();
      if (stage) diagnostics.record(stage, 'passed', hostId);
      return result;
    } catch (error) {
      if (stage) diagnostics.failure(error, stage, hostId);
      throw error;
    }
  });
}
function sessionFor(owner: BrowserWindow) {
  let session = sessions.get(owner.id);
  if (session) return session;
  const send = (channel: string, value: unknown) => {
    for (const [id, candidate] of sessions.entries()) {
      if (candidate === session) {
        const destination = windows.get(id);
        if (destination && !destination.isDestroyed()) destination.webContents.send(channel, value);
        break;
      }
    }
  };
  session = new RelaySession({
    frame: (data) => mediaBySession.get(session!)?.video(Buffer.from(data)),
    message: (data, binary) =>
      mediaBySession.get(session!)?.message(Buffer.from(data), binary) ?? false,
    notice: (notice) => {
      const hostId = session?.target?.hostId;
      if (notice.type === 'status' && notice.state === 'live')
        diagnostics.record('stream', 'passed', hostId);
      if ((notice.type === 'status' && notice.state === 'failed') || notice.type === 'error')
        diagnostics.failure(notice.message, 'stream', hostId);
      send('notice', notice);
    },
    open: async ({ hostId, udid, fps }, signal) => {
      const saved = profile(hostId);
      const p = await selectMacRoute(saved, signal);
      parseHostInfo(
        JSON.parse((await remoteRequest(p, 'GET', '/info', undefined, signal)).toString()),
      );
      const inventory = JSON.parse(
        (await remoteRequest(p, 'GET', '/devices', undefined, signal)).toString(),
      ) as Inventory;
      const device = inventory.devices.find((d) => d.udid === udid);
      if (!device)
        throw new SessionFailure('This simulator no longer exists. Refresh the list.', true);
      if (device.state !== 'Booted')
        throw new SessionFailure(
          'This simulator is not booted. Use Start & connect to start it explicitly.',
          true,
        );
      identities.set(session!, { host: publicProfile(p), device, fps });
      signal.throwIfAborted();
      const url = new URL(`/stream/${udid}?fps=${fps}`, p.url);
      url.protocol = 'wss:';
      const socket = new WebSocket(url, {
        ...tlsOptions(p),
        headers: { Authorization: `Bearer ${p.token}` },
        handshakeTimeout: 10000,
        maxPayload: 16 * 1024 * 1024,
        perMessageDeflate: false,
      });
      const media = new ClientMedia(
        socket,
        saved,
        (channel, value) => {
          if (mediaBySession.get(session!) === media) send(channel, value);
        },
        fps,
      );
      mediaBySession.set(session!, media);
      socket.once('close', () => {
        void media.close();
        if (mediaBySession.get(session!) === media) mediaBySession.delete(session!);
      });
      // A canceled preflight can discard a just-created socket before RelaySession attaches.
      socket.on('error', () => {});
      socket.on('unexpected-response', (_req, response) => {
        socket.emit(
          'error',
          new SessionFailure(
            `Host returned HTTP ${response.statusCode}. Pair again for authorization errors.`,
            [401, 403, 404, 409, 426].includes(response.statusCode ?? 0),
          ),
        );
        response.destroy();
        socket.terminate();
      });
      let pong = true;
      socket.on('pong', () => {
        pong = true;
      });
      const heartbeat = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (!pong) socket.terminate();
        else {
          pong = false;
          socket.ping();
        }
      }, 10000);
      const startup = setTimeout(() => {
        socket.emit('error', new Error('The simulator did not start streaming within 60 seconds.'));
        socket.terminate();
      }, 60000);
      socket.on('message', (data, binary) => {
        if (!binary) {
          try {
            const type = JSON.parse(data.toString()).type;
            if (type === 'metadata' || type === 'error') clearTimeout(startup);
          } catch {
            /* RelaySession reports malformed metadata. */
          }
        }
      });
      socket.once('close', () => {
        clearInterval(heartbeat);
        clearTimeout(startup);
      });
      return socket;
    },
  });
  sessions.set(owner.id, session);
  return session;
}
function selectionFor(session?: RelaySession): DisplayContext | undefined {
  if (!session?.target) return;
  const { hostId, udid, fps } = session.target;
  const known = identities.get(session);
  return {
    host: publicProfile(profile(hostId)),
    device: known?.device ?? { udid, name: udid, runtime: '', state: 'Unknown' },
    fps,
  };
}
function validateDisplay(udid: string, fps: number) {
  if (!/^[\da-f-]{36}$/i.test(udid) || ![15, 30, 60].includes(fps))
    throw new Error('Choose a simulator and frame rate.');
}
async function loadWindow(owner: BrowserWindow, display = false) {
  if (process.env.SIM_RELAY_DEV === '1')
    await owner.loadURL(`http://127.0.0.1:5173${display ? '?display=1' : ''}`);
  else
    await owner.loadFile(path.join(__dirname, '../dist/index.html'), {
      query: display ? { display: '1' } : {},
    });
}
function createWindow(display = false) {
  const owner = new BrowserWindow({
    width: display ? 680 : 1440,
    height: display ? 900 : 960,
    minWidth: display ? 360 : 980,
    minHeight: display ? 360 : 680,
    title: 'Sim Relay',
    icon: path.join(__dirname, '../assets/app-icon.png'),
    backgroundColor: '#101214',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windows.set(owner.id, owner);
  recordingClose.protect(owner);
  owner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  owner.webContents.on('will-navigate', (event) => event.preventDefault());
  owner.webContents.on('will-attach-webview', (event) => event.preventDefault());
  owner.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  owner.on('blur', () => sessions.get(owner.id)?.release());
  owner.on('closed', () => {
    disconnect(owner);
    sessions.delete(owner.id);
    displays.delete(owner.id);
    windows.delete(owner.id);
  });
  return owner;
}
async function detach(owner: BrowserWindow, context: DisplayContext) {
  const display = createWindow(true);
  displays.set(display.id, context);
  const session = sessions.get(owner.id);
  context.sessionActive = !!session?.active;
  if (session?.target?.hostId === context.host.id && session.target.udid === context.device.udid) {
    session.release();
    sessions.move(owner.id, display.id);
    mediaBySession.get(session)?.reparent();
    owner.webContents.send('notice', {
      type: 'status',
      state: 'off',
      message: 'Display moved to its own window.',
    });
  }
  await loadWindow(display, true);
  display.setTitle(`${context.device.name} — ${context.host.name} — Sim Relay`);
}
async function main() {
  await mkdir(app.getPath('userData'), { recursive: true });
  const checkUpdates = createUpdateChecker({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    installation: process.execPath.startsWith('/nix/store/') ? 'nix' : 'unknown',
  });
  handle('check-updates', checkUpdates);
  handle('open-update-link', async (url: string) => {
    if (typeof url !== 'string' || !releaseLink(url))
      throw new Error('Open an official Sim Relay release link.');
    await shell.openExternal(url);
  });
  secureStorageAvailable =
    (await safeStorage.isAsyncEncryptionAvailable().catch(() => false)) &&
    !(
      process.platform === 'linux' &&
      ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())
    );
  if (secureStorageAvailable) {
    try {
      const entries = JSON.parse(
        await readFile(path.join(app.getPath('userData'), 'hosts.json'), 'utf8'),
      ) as Profile[];
      for (const p of entries) {
        try {
          p.token = (await safeStorage.decryptStringAsync(Buffer.from(p.token, 'base64'))).result;
          p.url = hostUrl(p.url).origin;
          p.addresses = macAddresses(p);
          p.currentRoute = undefined;
          profiles.set(p.id, p);
        } catch {
          /* An unavailable keychain requires pairing again. */
        }
      }
    } catch {
      /* First launch. */
    }
  }
  discovery = new Bonjour({}, () => {});
  const browser = discovery.find({ type: 'simrelay' });
  browser.on('up', (service) => {
    const address = service.addresses?.find((a) => /^\d+\./.test(a)) ?? service.host;
    const url = `https://${address}:${service.port}`;
    discovered.set(service.fqdn, {
      id: service.fqdn,
      name: service.txt?.name || service.name,
      url,
      fingerprint: service.txt?.fingerprint,
      source: 'discovered',
    });
  });
  browser.on('down', (service) => discovered.delete(service.fqdn));
  handle('hosts', () =>
    [...profiles.values()]
      .map(publicProfile)
      .concat(discoveredMacs([...profiles.values()], [...discovered.values()])),
  );
  handle('probe', probeHost);
  handle('diagnostics', (id?: string) => {
    if (id !== undefined && (typeof id !== 'string' || id.length > 1024))
      throw new Error('Choose a paired Mac.');
    return diagnostics.refresh(id);
  });
  handle(
    'export-diagnostics',
    async (owner: BrowserWindow, report: unknown) => {
      // Revalidate the reviewed report in the main process. No arbitrary text/files.
      const text = serializeReport(report);
      const result = await dialog.showSaveDialog(owner, {
        title: 'Save reviewed diagnostic report',
        defaultPath: 'Sim-Relay-diagnostics.json',
        filters: [{ name: 'Diagnostic report', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return false;
      await writeFile(result.filePath, text, { mode: 0o600 });
      return true;
    },
    true,
  );
  handle('copy-text', (text: string) => {
    if (typeof text !== 'string' || text.length > 1000000)
      throw new Error('Text is too large to copy.');
    clipboard.writeText(text);
  });
  handle('pair', async (probe: Probe, token: string) => {
    hostUrl(probe.url);
    if (
      !token ||
      token.length > 256 ||
      new X509Certificate(probe.certificate).fingerprint256 !== probe.fingerprint
    )
      throw new Error('Check the certificate and pairing token.');
    const address = hostUrl(probe.url).origin;
    const sameMac = [...profiles.values()].find(
      (p) =>
        p.fingerprint === probe.fingerprint &&
        new X509Certificate(p.certificate).raw.equals(new X509Certificate(probe.certificate).raw),
    );
    if (sameMac && !macAddresses(sameMac).includes(address)) {
      await verifyMacAddress(sameMac, address);
      if (profiles.get(sameMac.id) !== sameMac)
        throw new Error('Saved pairing changed. Connect to the Mac again.');
      Object.assign(sameMac, editMacAddress(sameMac, 'add', address));
      sameMac.sessionOnly = !(await saveProfiles());
      return publicProfile(sameMac);
    }
    const previous = [...profiles.values()].find((p) => macAddresses(p).includes(address));
    let entry: Profile = {
      id: previous?.id ?? randomUUID(),
      name: probe.info.name,
      url: sameMac?.url ?? address,
      addresses: sameMac ? macAddresses(sameMac) : [address],
      currentRoute: address,
      certificate: probe.certificate,
      fingerprint: probe.fingerprint,
      token: token.trim(),
      source: 'saved',
    };
    entry = await pairRemoteClient(entry, probe, `${hostname()} (${process.platform})`);
    for (const [, session] of sessions.entries())
      if (session.target?.hostId === entry.id) session.disconnect();
    profiles.set(entry.id, entry);
    entry.sessionOnly = !(await saveProfiles());
    return publicProfile(entry);
  });
  for (const action of ['add', 'remove', 'prefer'] as const) {
    handle(`${action}-address`, async (id: string, value: string) => {
      const original = profile(id);
      editMacAddress(original, action, value);
      if (action === 'add') await verifyMacAddress(original, value);
      if (profiles.get(id) !== original)
        throw new Error('Saved pairing changed. Reopen its addresses.');
      const next = editMacAddress(original, action, value);
      if (
        action === 'prefer' ||
        (action === 'remove' && original.currentRoute === hostUrl(value).origin)
      ) {
        for (const [, session] of sessions.entries()) {
          if (session.target?.hostId !== id) continue;
          session.disconnect();
          void mediaBySession.get(session)?.close();
        }
      }
      // Keep the existing profile object live for recording downloads and active displays.
      Object.assign(original, next);
      original.sessionOnly = !(await saveProfiles());
      return publicProfile(original);
    });
  }
  handle('forget', async (id: string) => {
    await protectRecordingOwners('Forget this Mac', id);
    for (const [, session] of sessions.entries())
      if (session.target?.hostId === id) session.disconnect();
    profiles.delete(id);
    if (!(await saveProfiles())) {
      // Forgetting still removes the encrypted on-disk entry when the keychain is locked.
      const file = path.join(app.getPath('userData'), 'hosts.json');
      let entries: Profile[];
      try {
        entries = JSON.parse(await readFile(file, 'utf8')) as Profile[];
      } catch {
        return;
      }
      await writeFile(file, JSON.stringify(entries.filter((p) => p.id !== id)), { mode: 0o600 });
    }
  });
  handle('request', async (id: string, method: string, pathname: string, body?: unknown) => {
    if (requestMayLoseRecording(method, pathname, body))
      await protectRecordingOwners(
        'Run this simulator action',
        id,
        /^\/devices\/([^/]+)\//.exec(pathname)?.[1],
      );
    return JSON.parse((await remoteRequest(profile(id), method, pathname, body)).toString());
  });
  handle(
    'connect',
    async (owner: BrowserWindow, id: string, udid: string, fps: number) => {
      validateDisplay(udid, fps);
      const existing = sessions.ownerOf(id, udid);
      if (existing !== undefined && existing !== owner.id) {
        windows.get(existing)?.show();
        windows.get(existing)?.focus();
        throw new Error('This simulator is already open in another display. Use that window.');
      }
      const session = sessionFor(owner);
      await session.connect({ hostId: id, udid, fps });
      mediaBySession.get(session)?.reannounce();
    },
    true,
  );
  handle('disconnect', disconnect, true);
  const mediaForWindow = (owner: BrowserWindow) => {
    const session = sessions.get(owner.id);
    const media = session && mediaBySession.get(session);
    if (!media || !session?.active) throw new Error('Connect to a simulator first.');
    return media;
  };
  handle(
    'media-quality',
    (owner: BrowserWindow, limits: QualityLimits) => mediaForWindow(owner).quality(limits),
    true,
  );
  handle(
    'media-command',
    async (owner: BrowserWindow, action: MediaAction, consent?: boolean) => {
      if (
        ![
          'recording-start',
          'recording-stop',
          'recording-discard',
          'audio-start',
          'audio-stop',
        ].includes(action)
      )
        throw new Error('Unknown media action.');
      await mediaForWindow(owner).command(action, consent === true);
    },
    true,
  );
  handle(
    'save-recording',
    (owner: BrowserWindow) =>
      mediaForWindow(owner).save(async () => {
        const result = await dialog.showSaveDialog(owner, {
          defaultPath: `Simulator-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`,
          filters: [{ name: 'MP4 video (silent)', extensions: ['mp4'] }],
        });
        return result.canceled ? undefined : result.filePath;
      }),
    true,
  );
  for (const channel of ['video-consumed', 'audio-consumed', 'video-feedback']) {
    ipcMain.on(channel, (event, value) => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner || !windows.has(owner.id) || event.senderFrame !== owner.webContents.mainFrame)
        return;
      const session = sessions.get(owner.id);
      const media = session && mediaBySession.get(session);
      if (channel === 'video-consumed') media?.consumed();
      else if (channel === 'audio-consumed') media?.consumedAudio();
      else {
        try {
          media?.feedback(value);
        } catch {
          /* Ignore stale feedback. */
        }
      }
    });
  }

  handle(
    'retry',
    (owner: BrowserWindow) => {
      const session = sessionFor(owner),
        target = session.target;
      if (target) {
        const existing = sessions.ownerOf(target.hostId, target.udid);
        if (existing !== undefined && existing !== owner.id)
          throw new Error('This simulator is already open in another display. Use that window.');
      }
      return session.retry();
    },
    true,
  );
  handle(
    'display-context',
    (owner: BrowserWindow) => {
      if (displays.has(owner.id)) return displays.get(owner.id);
      if (owner === window) {
        const context = workspaceContext;
        workspaceContext = undefined;
        return context;
      }
    },
    true,
  );
  handle(
    'pop-out',
    async (owner: BrowserWindow, id: string, udid: string, fps: number) => {
      validateDisplay(udid, fps);
      const existing = sessions.ownerOf(id, udid);
      if (existing !== undefined && existing !== owner.id) {
        windows.get(existing)?.show();
        windows.get(existing)?.focus();
        return;
      }
      const selection = selectionFor(sessions.get(owner.id));
      let device =
        selection?.host.id === id && selection.device.udid === udid ? selection.device : undefined;
      if (!device) {
        const inventory = JSON.parse(
          (await remoteRequest(profile(id), 'GET', '/devices')).toString(),
        ) as Inventory;
        device = inventory.devices.find((d) => d.udid === udid);
      }
      if (!device) throw new Error('This simulator no longer exists. Refresh the list.');
      await detach(owner, { host: publicProfile(profile(id)), device, fps });
    },
    true,
  );
  handle(
    'return-display',
    async (owner: BrowserWindow) => {
      const context = displays.get(owner.id);
      if (!context) return;
      let reopenWorkspace = window.isDestroyed();
      if (reopenWorkspace) window = createWindow();
      const workspaceSession = sessions.get(window.id);
      const previous = workspaceSession?.active ? workspaceSession.target : undefined;
      if (previous) await detach(window, selectionFor(workspaceSession)!);
      // The OS may close either window while the detached renderer is loading.
      if (owner.isDestroyed()) return;
      if (window.isDestroyed()) {
        window = createWindow();
        reopenWorkspace = true;
      }
      sessions.delete(window.id);
      const session = sessions.get(owner.id);
      context.sessionActive = !!session?.active;
      if (session) {
        session.release();
        sessions.move(owner.id, window.id);
        mediaBySession.get(session)?.reparent();
        context.fps = session.target?.fps ?? context.fps;
      }
      if (reopenWorkspace) {
        workspaceContext = context;
        await loadWindow(window);
      } else window.webContents.send('return-display', context);
      window.show();
      window.focus();
      owner.close();
    },
    true,
  );
  handle(
    'window-action',
    (owner: BrowserWindow, action: string) => {
      if (action === 'maximize') owner.isMaximized() ? owner.unmaximize() : owner.maximize();
      if (action === 'fullscreen') owner.setFullScreen(!owner.isFullScreen());
    },
    true,
  );
  ipcMain.on('input', (event, input) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || !windows.has(owner.id) || event.senderFrame !== owner.webContents.mainFrame)
      return;
    const parsed = inputSchema.safeParse(input);
    if (parsed.success) sessions.get(owner.id)?.input(parsed.data);
  });
  registerHostManagement(handle, hostService, (action) =>
    protectRecordingOwners(
      action === 'restart' ? 'Restart sharing this Mac' : 'Stop sharing this Mac',
    ),
  );
  handle(
    'host-status',
    async (): Promise<HostStatus> => (await hostService.status()).host ?? { running: false },
  );
  handle('start-host', async () => (await hostService.action('start')).host ?? { running: false });
  handle('stop-host', async () => {
    await protectRecordingOwners('Stop sharing this Mac');
    await hostService.action('stop');
  });
  handle(
    'save-screenshot',
    async (owner: BrowserWindow, id: string, udid: string) => {
      if (!/^[\da-f-]{36}$/i.test(udid)) throw new Error('Choose a simulator.');
      const result = await dialog.showSaveDialog(owner, {
        defaultPath: `Simulator-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
        filters: [{ name: 'PNG image', extensions: ['png'] }],
      });
      if (result.canceled || !result.filePath) return false;
      await writeFile(
        result.filePath,
        await remoteRequest(profile(id), 'GET', `/devices/${udid}/screenshot`),
      );
      return true;
    },
    true,
  );
  handle(
    'install-app',
    async (owner: BrowserWindow, id: string, udid: string) => {
      if (!/^[\da-f-]{36}$/i.test(udid)) throw new Error('Choose a simulator.');
      const result = await dialog.showOpenDialog(owner, {
        title: 'Install a simulator app',
        properties: ['openFile'],
        filters: [{ name: 'Zipped simulator app (.app.zip)', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePaths[0]) return false;
      const file = result.filePaths[0];
      if ((await stat(file)).size > 128 * 1024 * 1024)
        throw new Error('Choose an app archive smaller than 128 MB.');
      await remoteRequest(profile(id), 'POST', `/devices/${udid}/install`, await readFile(file));
      return true;
    },
    true,
  );
  window = createWindow();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Sim Relay',
        submenu: [
          { role: 'about' },
          ...(process.platform === 'darwin' &&
          existsSync(path.join(process.resourcesPath, 'bin/sim-relay-host'))
            ? [{ label: 'Install host command…', click: () => void installHostCommand() }]
            : []),
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'togglefullscreen' },
        ],
      },
    ]),
  );
  await loadWindow(window);
}
app
  .whenReady()
  .then(main)
  .catch((error) => {
    dialog.showErrorBox('Cannot start Sim Relay', error.message);
    app.quit();
  });
let quitting = false;
let decidingQuit = false;
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  if (decidingQuit) return;
  decidingQuit = true;
  void (async () => {
    // Keep every session alive until each owner has saved or explicitly discarded.
    if (
      !(await recordingClose.confirmOwners([...windows.values()], 'Quit Sim Relay')) ||
      [...windows.values()].some(windowHasUnsavedRecording)
    ) {
      decidingQuit = false;
      return;
    }
    quitting = true;
    const cleanups: Promise<unknown>[] = [];
    for (const [, session] of sessions.entries()) {
      session.disconnect();
      cleanups.push(mediaBySession.get(session)?.close() ?? Promise.resolve());
    }
    discovery?.destroy();
    await Promise.allSettled(cleanups);
    app.quit();
  })();
});
