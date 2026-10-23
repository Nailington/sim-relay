import https from 'node:https';
import packageMetadata from '../../package.json';
import { HOST_PROTOCOL_VERSION } from '../shared/host-info';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname, networkInterfaces, platform } from 'node:os';
import { Bonjour } from 'bonjour-service';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { identity } from './security';
import { clientAuthorizations } from './clients';
import { clientAdminServer } from './client-admin';
import { MacSimulator, exec, companionExecutable } from './simulator';
import { inputSchema } from './protocol';
import { extractAppArchive } from './archive';
import type { HostInfo, HostStatus, InputEvent, StreamMeta } from '../shared/types';

export interface Backend {
  inventory(): ReturnType<MacSimulator['inventory']>;
  run(args: string[], binary?: boolean, stdin?: string): Promise<string | Buffer>;
  session(
    udid: string,
    fps: number,
    frame: (frame: Buffer) => void,
    error: (e: Error) => void,
    signal?: AbortSignal,
  ): Promise<{ metadata: StreamMeta; input(e: InputEvent): void; close(): Promise<void> }>;
}
const uuid = z.string().uuid();
const commandSchema = z.object({
  args: z.array(z.string().max(4096)).min(1).max(100),
  confirmed: z.boolean().optional(),
});
const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  deviceType: z.string().startsWith('com.apple.CoreSimulator.SimDeviceType.'),
  runtime: z.string().startsWith('com.apple.CoreSimulator.SimRuntime.iOS-'),
});
async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}
export async function startHost(options: {
  directory: string;
  port?: number;
  bind?: string;
  advertise?: boolean;
  backend?: Backend;
  info?: HostInfo;
}) {
  if (!options.backend && platform() !== 'darwin')
    throw new Error(
      'Hosting requires a Mac with Xcode. You can connect to a Mac from this computer.',
    );
  const backend = options.backend ?? new MacSimulator();
  const credentials = await identity(options.directory);
  const clients = await clientAuthorizations(options.directory);
  const info: HostInfo = options.info ?? {
    name: hostname().replace(/\.local$/, ''),
    platform: 'macOS',
    version: packageMetadata.version,
    protocolVersion: HOST_PROTOCOL_VERSION,
    xcode: await exec('xcrun', ['simctl', 'help'], { timeout: 10000 })
      .then(() => true)
      .catch(() => false),
    companion: await exec(companionExecutable(), ['--help'], { timeout: 10000 })
      .then(() => true)
      .catch(() => false),
  };
  info.clientAuthorization = true;
  info.protocolVersion = HOST_PROTOCOL_VERSION;
  const controllers = new Map<string, WebSocket>();
  const controllerClosers = new Map<string, () => Promise<void>>();
  const clientStreams = new Map<WebSocket, string>();
  const streamClosers = new Set<() => Promise<void>>();
  const socketClosers = new Map<WebSocket, () => Promise<void>>();
  const server = https.createServer(
    { cert: credentials.cert, key: credentials.key, minVersion: 'TLSv1.2' },
    async (req, res) => {
      // No browser CORS access or cookie authentication. Desktop clients supply a bearer token.
      if (req.headers.origin)
        return json(res, 403, { error: 'Use the Sim Relay desktop app to connect.' });
      const pathname = new URL(req.url ?? '/', 'https://localhost').pathname;
      if (pathname === '/info' && req.method === 'GET') return json(res, 200, info);
      if (pathname === '/pair' && req.method === 'POST') {
        try {
          const { name } = z
            .object({
              name: z
                .string()
                .trim()
                .min(1)
                .max(100)
                .regex(/^[^\x00-\x1f\x7f]+$/),
            })
            .parse(await body(req));
          return json(res, 201, await clients.pair(req.headers.authorization, name));
        } catch {
          return json(res, 401, {
            error: 'Pairing code is incorrect or already used. Get the current code from the Mac.',
          });
        }
      }
      if (!clients.authenticate(req.headers.authorization))
        return json(res, 401, {
          error:
            'This client is no longer authorized. Pair with the Mac again using its current pairing code.',
          code: 'authorization_required',
        });
      try {
        if (pathname === '/devices' && req.method === 'GET')
          return json(res, 200, await backend.inventory());
        if (pathname === '/devices' && req.method === 'POST') {
          const data = createSchema.parse(await body(req));
          const inventory = await backend.inventory();
          const runtime = inventory.runtimes.find((r) => r.identifier === data.runtime);
          if (!runtime || !inventory.devicetypes.some((d) => d.identifier === data.deviceType))
            throw new Error('Choose an installed iOS runtime and device type.');
          const udid = String(
            await backend.run(['create', data.name, data.deviceType, data.runtime]),
          ).trim();
          return json(res, 201, { udid });
        }
        const install = pathname.match(/^\/devices\/([^/]+)\/install$/);
        if (install && req.method === 'POST') {
          const udid = uuid.parse(install[1]);
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 128 * 1024 * 1024)
              throw new Error('Choose an app archive smaller than 128 MB.');
            chunks.push(chunk);
          }
          const archive = await extractAppArchive(Buffer.concat(chunks));
          try {
            await backend.run(['install', udid, archive.appPath]);
          } finally {
            await archive.close();
          }
          return json(res, 200, { ok: true });
        }
        const route = pathname.match(
          /^\/devices\/([^/]+)\/(boot|shutdown|screenshot|url|location|appearance|text)$/,
        );
        if (route) {
          const udid = uuid.parse(route[1]),
            action = route[2];
          if (action === 'screenshot' && req.method === 'GET') {
            const data = await backend.run(['io', udid, 'screenshot', '--type=png', '-'], true);
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
            res.end(data);
            return;
          }
          if (req.method !== 'POST') return json(res, 405, { error: 'Use POST for this action.' });
          if (action === 'boot') {
            const inventory = await backend.inventory();
            const device = inventory.devices.find((d) => d.udid === udid);
            if (!device) throw new Error('This simulator no longer exists. Refresh the list.');
            if (device.state !== 'Booted') await backend.run(['boot', udid]);
            await backend.run(['bootstatus', udid, '-b']);
          } else if (action === 'shutdown') await backend.run(['shutdown', udid]);
          else if (action === 'text') {
            const data = z.object({ text: z.string().min(1).max(16000) }).parse(await body(req));
            await backend.run(['pbcopy', udid], false, data.text);
          } else if (action === 'url') {
            const data = z.object({ url: z.string().url().max(8192) }).parse(await body(req));
            await backend.run(['openurl', udid, data.url]);
          } else if (action === 'location') {
            const data = z
              .object({
                latitude: z.number().min(-90).max(90),
                longitude: z.number().min(-180).max(180),
              })
              .parse(await body(req));
            await backend.run(['location', udid, 'set', `${data.latitude},${data.longitude}`]);
          } else if (action === 'appearance') {
            const data = z.object({ appearance: z.enum(['light', 'dark']) }).parse(await body(req));
            await backend.run(['ui', udid, 'appearance', data.appearance]);
          }
          return json(res, 200, { ok: true });
        }
        if (pathname === '/command' && req.method === 'POST') {
          const { args, confirmed } = commandSchema.parse(await body(req));
          if (args.some((a) => /\0/.test(a)) || args[0].startsWith('-'))
            throw new Error('Enter a simctl subcommand, without xcrun or simctl.');
          if (['erase', 'delete', 'delete_cache', 'runtime'].includes(args[0]) && !confirmed)
            return json(res, 409, {
              error: 'Confirm this command to change or delete simulator data.',
              confirmationRequired: true,
            });
          return json(res, 200, { output: String(await backend.run(args)) });
        }
        json(res, 404, { error: 'Unknown host action.' });
      } catch (e) {
        const error = e as Error & { stderr?: string };
        json(res, 400, { error: (error.stderr || error.message).slice(0, 3000) });
      }
    },
  );
  server.requestTimeout = 130_000;
  server.headersTimeout = 10_000;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
    perMessageDeflate: false,
  });
  server.on('upgrade', (req, socket, head) => {
    const clientId = clients.authenticate(req.headers.authorization);
    if (req.headers.origin || !clientId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? '/', 'https://localhost');
    const udid = url.pathname.match(/^\/stream\/([^/]+)$/)?.[1];
    if (!uuid.safeParse(udid).success) {
      socket.destroy();
      return;
    }
    const fps = Number(url.searchParams.get('fps') ?? 30);
    if (![15, 30, 60].includes(fps)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!clients.authenticate(req.headers.authorization)) {
        ws.close(4003, 'Authorization required');
        return;
      }
      clientStreams.set(ws, clientId);
      ws.once('close', () => clientStreams.delete(ws));
      wss.emit('connection', ws, udid, fps);
    });
  });
  wss.on('connection', async (ws: WebSocket, udid: string, fps: number) => {
    const send = (value: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
    };
    // A quality change or immediate reconnect may arrive while the old companion
    // is draining releases. Wait for that closing lease instead of reporting a
    // different controlling client or starting two companions for the same device.
    ws.on('error', () => {});
    const previous = controllers.get(udid);
    if (previous && previous.readyState !== WebSocket.OPEN) await controllerClosers.get(udid)?.();
    if (ws.readyState !== WebSocket.OPEN) return;
    if (controllers.has(udid)) {
      send({
        type: 'error',
        terminal: true,
        message: 'This simulator is controlled by another client. Disconnect that client first.',
      });
      ws.close();
      return;
    }
    controllers.set(udid, ws);
    let session: Awaited<ReturnType<Backend['session']>> | undefined;
    let pending: ReturnType<Backend['session']> | undefined;
    let closing: Promise<void> | undefined;
    let sentDimensions = '';
    const metadataKey = (metadata: StreamMeta) => JSON.stringify(metadata);
    const abort = new AbortController();
    let alive = true,
      opening = true;
    const cleanup = (): Promise<void> => {
      alive = false;
      abort.abort();
      return (closing ??= (async () => {
        try {
          await (session ?? (await pending))?.close();
        } catch {
          /* Startup may have been canceled. */
        }
        if (controllers.get(udid) === ws) {
          controllers.delete(udid);
          controllerClosers.delete(udid);
        }
        streamClosers.delete(cleanup);
        socketClosers.delete(ws);
      })());
    };
    controllerClosers.set(udid, cleanup);
    streamClosers.add(cleanup);
    socketClosers.set(ws, cleanup);
    ws.on('close', () => {
      void cleanup();
    });
    ws.on('error', () => {
      void cleanup();
    });
    let pong = true;
    ws.on('pong', () => {
      pong = true;
    });
    const heartbeat = setInterval(() => {
      if (!pong) ws.terminate();
      else {
        pong = false;
        ws.ping();
      }
    }, 10_000);
    ws.once('close', () => clearInterval(heartbeat));
    let rateStart = Date.now(),
      count = 0;
    ws.on('message', (raw) => {
      if (!alive) return;
      if (Date.now() - rateStart > 1000) {
        rateStart = Date.now();
        count = 0;
      }
      if (++count > 300) {
        send({ type: 'error', message: 'Too many input events. Reconnect to continue.' });
        ws.close();
        return;
      }
      try {
        const event = inputSchema.parse(JSON.parse(raw.toString()));
        if (session) session.input(event);
        else if (!opening) throw new Error('The input service is unavailable.');
      } catch (e) {
        send({ type: 'error', message: (e as Error).message });
      }
    });
    try {
      const device = (await backend.inventory()).devices.find((d) => d.udid === udid);
      if (!device || device.state !== 'Booted') {
        send({
          type: 'error',
          terminal: true,
          message: device
            ? 'This simulator is not booted. Start it explicitly before connecting.'
            : 'This simulator no longer exists.',
        });
        ws.close();
        return;
      }
      if (!alive) return;
      pending = backend.session(
        udid,
        fps,
        (data) => {
          if (alive && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 2 * 1024 * 1024) {
            if (session && sentDimensions !== metadataKey(session.metadata)) {
              send({ type: 'metadata', metadata: session.metadata });
              sentDimensions = metadataKey(session.metadata);
            }
            ws.send(data);
          }
        },
        (error) => {
          send({ type: 'error', message: error.message });
          ws.close();
        },
        abort.signal,
      );
      session = await pending;
      opening = false;
      if (!alive) await cleanup();
      else {
        sentDimensions = metadataKey(session.metadata);
        send({ type: 'metadata', metadata: session.metadata });
      }
    } catch (e) {
      opening = false;
      send({ type: 'error', message: (e as Error).message });
      ws.close();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 49300, options.bind ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  let closeAdmin: () => Promise<void>;
  try {
    closeAdmin = await clientAdminServer(options.directory, async (request) => {
      const data = z
        .discriminatedUnion('action', [
          z.object({ action: z.literal('list') }),
          z.object({ action: z.literal('revoke'), id: uuid }),
          z.object({ action: z.literal('pairing') }),
        ])
        .parse(request);
      if (data.action === 'pairing')
        return { token: clients.pairingToken, fingerprint: credentials.fingerprint };
      if (data.action === 'list')
        return clients.list(
          (id) => [...clientStreams.values()].filter((value) => value === id).length,
        );
      await clients.revoke(data.id);
      for (const [ws, id] of clientStreams) {
        if (id !== data.id) continue;
        if (ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({
              type: 'error',
              code: 'authorization_required',
              message: 'Access was revoked on the Mac. Pair with the Mac again to reconnect.',
            }),
          );
        ws.close(4003, 'Authorization revoked');
        // Cleanup cannot depend on an uncooperative remote client completing the close handshake.
        await socketClosers.get(ws)?.();
        const timeout = setTimeout(() => ws.terminate(), 1000);
        timeout.unref();
        ws.once('close', () => clearTimeout(timeout));
      }
      return { revoked: data.id };
    });
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  const port = (server.address() as { port: number }).port;
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(options.bind ?? '');
  const bonjour =
    options.advertise === false || loopback
      ? undefined
      : new Bonjour({}, () => {
          /* Direct connections still work if multicast is blocked. */
        });
  bonjour?.publish({
    name: `Sim Relay · ${info.name}`,
    type: 'simrelay',
    port,
    txt: {
      name: info.name,
      fingerprint: credentials.fingerprint,
      version: String(HOST_PROTOCOL_VERSION),
    },
  });
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && !a.internal && a.family === 'IPv4')
    .map((a) => `https://${a!.address}:${port}`);
  const status: HostStatus = {
    running: true,
    url: `https://${loopback ? '127.0.0.1' : hostname()}:${port}`,
    addresses: loopback ? [`https://127.0.0.1:${port}`] : addresses,
    get token() {
      return clients.pairingToken;
    },
    fingerprint: credentials.fingerprint,
    info,
  };
  return {
    status,
    server,
    async close() {
      await closeAdmin();
      for (const ws of wss.clients) ws.terminate();
      await Promise.allSettled([...streamClosers].map((close) => close()));
      await new Promise<void>((resolve) => {
        bonjour?.unpublishAll(() => {
          bonjour.destroy();
          resolve();
        });
        if (!bonjour) resolve();
      });
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
