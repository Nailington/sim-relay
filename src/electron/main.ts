import { app, BrowserWindow, ipcMain, safeStorage, dialog, Menu, clipboard } from 'electron';
import { Bonjour } from 'bonjour-service';
import { WebSocket } from 'ws';
import { randomUUID, X509Certificate } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { hostname } from 'node:os';
import { hostUrl, probeHost, remoteRequest, tlsOptions, pairRemoteClient } from './remote';
import { startHost } from '../host/server';
import { installHostCommand } from './host-command';
import { inputSchema } from '../host/protocol';
import type { HostEntry, Profile, Probe, HostStatus } from '../shared/types';

let window: BrowserWindow;
let discovery: Bonjour | undefined;
let stream: WebSocket | undefined;
let sharing: Awaited<ReturnType<typeof startHost>> | undefined;
const profiles = new Map<string, Profile>(),
  discovered = new Map<string, HostEntry>();
let secureStorageAvailable = false;
const publicProfile = ({ token: _token, certificate: _cert, ...entry }: Profile): HostEntry =>
  entry;
const profile = (id: string) => {
  const result = profiles.get(id);
  if (!result) throw new Error('Pair with this Mac first.');
  return result;
};
async function saveProfiles() {
  if (!secureStorageAvailable) return false;
  try {
    const entries = await Promise.all(
      [...profiles.values()].map(async (p) => ({
        ...p,
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
function disconnect() {
  const old = stream;
  stream = undefined;
  old?.close();
}
function handle(channel: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error('Unknown app window.');
    return fn(...args);
  });
}
async function main() {
  await mkdir(app.getPath('userData'), { recursive: true });
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
      .concat(
        [...discovered.values()].filter(
          (d) => ![...profiles.values()].some((p) => p.url === d.url),
        ),
      ),
  );
  handle('probe', probeHost);
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
    const previous = [...profiles.values()].find((p) => p.url === probe.url);
    let entry: Profile = {
      id: previous?.id ?? randomUUID(),
      name: probe.info.name,
      url: probe.url,
      certificate: probe.certificate,
      fingerprint: probe.fingerprint,
      token: token.trim(),
      source: 'saved',
    };
    entry = await pairRemoteClient(entry, probe, `${hostname()} (${process.platform})`);
    profiles.set(entry.id, entry);
    entry.sessionOnly = !(await saveProfiles());
    return publicProfile(entry);
  });
  handle('forget', async (id: string) => {
    disconnect();
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
  handle('request', async (id: string, method: string, pathname: string, body?: unknown) =>
    JSON.parse((await remoteRequest(profile(id), method, pathname, body)).toString()),
  );
  handle('connect', async (id: string, udid: string, fps: number) => {
    disconnect();
    if (!/^[\da-f-]{36}$/i.test(udid) || ![15, 30, 60].includes(fps))
      throw new Error('Choose a simulator and frame rate.');
    const p = profile(id),
      url = new URL(`/stream/${udid}?fps=${fps}`, p.url);
    url.protocol = 'wss:';
    const socket = new WebSocket(url, {
      ...tlsOptions(p),
      headers: { Authorization: `Bearer ${p.token}` },
      handshakeTimeout: 10000,
      maxPayload: 16 * 1024 * 1024,
      perMessageDeflate: false,
    });
    stream = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
      socket.on('message', (data, binary) => {
        if (stream !== socket || window.isDestroyed()) return;
        if (binary) window.webContents.send('frame', new Uint8Array(data as Buffer));
        else {
          try {
            window.webContents.send('notice', JSON.parse(data.toString()));
          } catch {
            socket.close();
          }
        }
      });
      socket.on('error', (error) => {
        if (stream === socket && !window.isDestroyed())
          window.webContents.send('notice', { type: 'error', message: error.message });
      });
      socket.once('close', () => {
        if (stream === socket) {
          stream = undefined;
          if (!window.isDestroyed()) window.webContents.send('notice', { type: 'closed' });
        }
      });
    });
  });
  handle('disconnect', disconnect);
  ipcMain.on('input', (event, input) => {
    if (event.sender === window.webContents && stream?.readyState === WebSocket.OPEN) {
      const parsed = inputSchema.safeParse(input);
      if (parsed.success) stream.send(JSON.stringify(parsed.data));
    }
  });
  handle('host-status', (): HostStatus => sharing?.status ?? { running: false });
  handle('start-host', async () => {
    sharing ??= await startHost({ directory: path.join(app.getPath('userData'), 'host') });
    return sharing.status;
  });
  handle('stop-host', async () => {
    await sharing?.close();
    sharing = undefined;
  });
  handle('save-screenshot', async (id: string, udid: string) => {
    if (!/^[\da-f-]{36}$/i.test(udid)) throw new Error('Choose a simulator.');
    const result = await dialog.showSaveDialog(window, {
      defaultPath: `Simulator-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(
      result.filePath,
      await remoteRequest(profile(id), 'GET', `/devices/${udid}/screenshot`),
    );
    return true;
  });
  handle('install-app', async (id: string, udid: string) => {
    if (!/^[\da-f-]{36}$/i.test(udid)) throw new Error('Choose a simulator.');
    const result = await dialog.showOpenDialog(window, {
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
  });
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 680,
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
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
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
  if (process.env.SIM_RELAY_DEV === '1') await window.loadURL('http://127.0.0.1:5173');
  else await window.loadFile(path.join(__dirname, '../dist/index.html'));
}
app
  .whenReady()
  .then(main)
  .catch((error) => {
    dialog.showErrorBox('Cannot start Sim Relay', error.message);
    app.quit();
  });
let quitting = false;
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  disconnect();
  discovery?.destroy();
  void (sharing?.close() ?? Promise.resolve()).finally(() => app.quit());
});
