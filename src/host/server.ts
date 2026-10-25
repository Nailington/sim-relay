import https from 'node:https';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { HostMedia, MediaPeer } from './media';
import { RecordingStore } from './recording';
import type { VideoSettings } from '../shared/media';
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
import { createKeepAwake } from './keep-awake';
import { allowsDevice, clientPermissionsSchema } from '../shared/permissions';
import {
  requirePermission,
  requireCommand,
  safeDeviceURL,
  PermissionDenied,
  permissionDenied,
  type Capability,
} from './permissions';
import { MacSimulator, exec, companionExecutable } from './simulator';
import { inputSchema } from './protocol';
import { extractAppArchive } from './archive';
import { RetirementError, retirementDeadline } from './process';
import type { HostInfo, HostStatus, InputEvent, StreamMeta } from '../shared/types';

export interface Backend {
  inventory(signal?: AbortSignal): ReturnType<MacSimulator['inventory']>;
  run(
    args: string[],
    binary?: boolean,
    stdin?: string,
    signal?: AbortSignal,
  ): Promise<string | Buffer>;
  session(
    udid: string,
    fps: number,
    frame: (frame: Buffer) => void,
    error: (e: Error) => void,
    signal?: AbortSignal,
  ): Promise<{
    metadata: StreamMeta;
    input(e: InputEvent): void;
    close(): Promise<void>;
    setVideoSettings?(settings: VideoSettings): void;
  }>;
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
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}
const authorizationRequired = {
  error:
    'This client is no longer authorized. Use an updated client for host protocol 2, then pair each device with the Mac using its current pairing code.',
  code: 'authorization_required',
};
class AuthorizationRequired extends Error {}
const streamCloseTimeout = 1000;
export async function startHost(options: {
  directory: string;
  port?: number;
  bind?: string;
  advertise?: boolean;
  backend?: Backend;
  info?: HostInfo;
  media?: HostMedia;
  /** A timeout fails shutdown; it never authorizes a retirement acknowledgement. */
  shutdownTimeoutMs?: number;
}) {
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 40000;
  if (
    !Number.isSafeInteger(shutdownTimeoutMs) ||
    shutdownTimeoutMs < 1 ||
    shutdownTimeoutMs > 120000
  )
    throw new Error('Choose a host shutdown deadline between 1 and 120000 milliseconds.');
  if (!options.backend && platform() !== 'darwin')
    throw new Error(
      'Hosting requires a Mac with Xcode. You can connect to a Mac from this computer.',
    );
  const backend = options.backend ?? new MacSimulator();
  const credentials = await identity(options.directory);
  const clients = await clientAuthorizations(options.directory, (id) => {
    void disconnectClient(id).catch(() => {});
  });
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
  const media =
    options.media ??
    new HostMedia(
      new RecordingStore(path.join(options.directory, 'recordings')),
      undefined,
      !options.backend && info.xcode,
    );
  await media.initialize();
  const keepAwake = await createKeepAwake(options.directory);
  let shuttingDown = false;
  info.clientAuthorization = true;
  info.protocolVersion = HOST_PROTOCOL_VERSION;
  const cleanupFailures: unknown[] = [];
  // A response can close long before its handler finishes aborting a process or
  // removing an extracted archive. Transport bookkeeping cannot join that work.
  const pendingHandlers = new Set<Promise<unknown>>();
  const tracked =
    <Args extends unknown[], T>(handler: (...args: Args) => Promise<T>) =>
    (...args: Args) => {
      const work = handler(...args);
      pendingHandlers.add(work);
      void work.then(
        () => pendingHandlers.delete(work),
        (error) => {
          pendingHandlers.delete(work);
          if (error instanceof RetirementError) cleanupFailures.push(error);
        },
      );
      return work;
    };
  const controllers = new Map<string, WebSocket>();
  const controllerClosers = new Map<string, () => Promise<void>>();
  const clientStreams = new Map<WebSocket, string>();
  const streamClosers = new Set<() => Promise<void>>();
  const socketClosers = new Map<WebSocket, () => Promise<void>>();
  const clientRequests = new Map<IncomingMessage, { clientId: string; revoke(): void }>();
  const server = https.createServer(
    { cert: credentials.cert, key: credentials.key, minVersion: 'TLSv1.2' },
    tracked(async (req: IncomingMessage, res: ServerResponse) => {
      if (shuttingDown) return json(res, 503, { error: 'The Mac host is stopping.' });
      // No browser CORS access or cookie authentication. Desktop clients supply a bearer token.
      if (req.headers.origin)
        return json(res, 403, { error: 'Use the Sim Relay desktop app to connect.' });
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', 'https://localhost').pathname;
      } catch {
        return json(res, 400, { error: 'Invalid request URL.' });
      }
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
          if (shuttingDown) return json(res, 503, { error: 'The Mac host is stopping.' });
          return json(res, 201, await clients.pair(req.headers.authorization, name));
        } catch {
          return json(res, 401, {
            error: 'Pairing code is incorrect or already used. Get the current code from the Mac.',
            code: 'pairing_code_invalid',
          });
        }
      }
      const clientId = clients.authenticate(req.headers.authorization);
      if (!clientId) return json(res, 401, authorizationRequired);
      const revision = clients.get(clientId)!.permissionRevision;
      const requestAbort = new AbortController();
      let revoked = false;
      clientRequests.set(req, {
        clientId,
        revoke() {
          revoked = true;
          requestAbort.abort();
          const stillPaired = !!clients.get(clientId);
          const denial = stillPaired ? permissionDenied : authorizationRequired;
          if (res.destroyed) return;
          if (res.headersSent) {
            // A download already has its status and length on the wire. Destroying
            // the response also tears down its file pipeline; a 401 cannot replace it.
            res.destroy();
            req.destroy();
            return;
          }
          // End the response and body reader even when a peer never finishes its upload.
          res.setHeader('Connection', 'close');
          res.once('finish', () => req.destroy());
          json(res, stillPaired ? 403 : 401, denial);
        },
      });
      const forgetRequest = () => {
        clientRequests.delete(req);
        if (!res.writableFinished) requestAbort.abort();
      };
      res.once('close', forgetRequest);
      const authorize = () => {
        if (shuttingDown || clients.authenticate(req.headers.authorization) !== clientId)
          throw new AuthorizationRequired();
        const client = clients.get(clientId)!;
        if (revoked || requestAbort.signal.aborted || client.permissionRevision !== revision)
          throw new PermissionDenied();
        return client.permissions;
      };
      let capability: Capability = 'view';
      let deviceId: string | undefined;
      let commandArgs: string[] | undefined;
      const permit = () => {
        const permissions = authorize();
        requirePermission(permissions, capability, deviceId);
        if (commandArgs) requireCommand(permissions, commandArgs);
        return permissions;
      };
      // Keep each check and backend dispatch in the same synchronous turn. Body reads,
      // inventory queries, archive extraction, and preceding commands can all yield to revoke.
      const inventory = () => {
        permit();
        return backend.inventory(requestAbort.signal).then((result) => {
          permit();
          return result;
        });
      };
      const run = (...args: Parameters<Backend['run']>) => {
        permit();
        return backend.run(args[0], args[1], args[2], requestAbort.signal).then(
          (result) => {
            permit();
            return result;
          },
          (error) => {
            if (error instanceof RetirementError) cleanupFailures.push(error);
            permit();
            throw error;
          },
        );
      };
      try {
        if (pathname === '/permissions' && req.method === 'GET')
          return json(res, 200, { permissions: authorize(), permissionRevision: revision });
        const download = pathname.match(/^\/recordings\/([\da-f-]{36})$/i);
        if (download && req.method === 'GET') {
          const ticket = req.headers['x-recording-ticket'];
          const recording = media.recordings.download(
            download[1],
            typeof ticket === 'string' ? ticket : undefined,
          );
          if (!recording)
            return json(res, 404, {
              error: 'Recording expired or was discarded. Record it again.',
            });
          capability = 'recordings';
          deviceId = recording.udid;
          permit();
          if (recording.clientId !== clientId) throw new PermissionDenied();
          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': recording.bytes,
            'Cache-Control': 'no-store',
            'Content-Disposition': 'attachment; filename="Simulator.mp4"',
            'X-Content-Type-Options': 'nosniff',
          });
          try {
            await pipeline(createReadStream(recording.file), res);
          } catch {
            res.destroy();
          }
          return;
        }
        if (pathname === '/devices' && req.method === 'GET') {
          const result = await inventory();
          const permissions = permit();
          return json(res, 200, {
            ...result,
            devices: result.devices.filter((device) => allowsDevice(permissions, device.udid)),
          });
        }
        if (pathname === '/devices' && req.method === 'POST') {
          capability = 'create';
          permit();
          const data = createSchema.parse(await body(req));
          const devices = await inventory();
          const runtime = devices.runtimes.find((r) => r.identifier === data.runtime);
          if (!runtime || !devices.devicetypes.some((d) => d.identifier === data.deviceType))
            throw new Error('Choose an installed iOS runtime and device type.');
          const udid = String(
            await run(['create', data.name, data.deviceType, data.runtime]),
          ).trim();
          return json(res, 201, { udid });
        }
        const install = pathname.match(/^\/devices\/([^/]+)\/install$/);
        if (install && req.method === 'POST') {
          const udid = uuid.parse(install[1]).toUpperCase();
          deviceId = udid;
          capability = 'installation';
          permit();
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 128 * 1024 * 1024)
              throw new Error('Choose an app archive smaller than 128 MB.');
            chunks.push(chunk);
          }
          permit();
          const archive = await extractAppArchive(Buffer.concat(chunks));
          try {
            await run(['install', udid, archive.appPath]);
          } finally {
            try {
              await archive.close();
            } catch (error) {
              throw new RetirementError('App archive cleanup failed.', { cause: error });
            }
          }
          return json(res, 200, { ok: true });
        }
        const route = pathname.match(
          /^\/devices\/([^/]+)\/(boot|shutdown|screenshot|url|location|appearance|text)$/,
        );
        if (route) {
          const udid = uuid.parse(route[1]).toUpperCase(),
            action = route[2];
          deviceId = udid;
          capability = action === 'screenshot' ? 'screenshots' : 'control';
          permit();
          if (action === 'screenshot' && req.method === 'GET') {
            const data = await run(['io', udid, 'screenshot', '--type=png', '-'], true);
            permit();
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
            res.end(data);
            return;
          }
          if (req.method !== 'POST') return json(res, 405, { error: 'Use POST for this action.' });
          if (action === 'boot') {
            const devices = await inventory();
            const device = devices.devices.find((d) => d.udid.toUpperCase() === udid);
            if (!device) throw new Error('This simulator no longer exists. Refresh the list.');
            if (device.state !== 'Booted') await run(['boot', udid]);
            await run(['bootstatus', udid, '-b']);
          } else if (action === 'shutdown') await run(['shutdown', udid]);
          else if (action === 'text') {
            const data = z.object({ text: z.string().min(1).max(16000) }).parse(await body(req));
            await run(['pbcopy', udid], false, data.text);
          } else if (action === 'url') {
            const data = z.object({ url: z.string().url().max(8192) }).parse(await body(req));
            if (!safeDeviceURL(data.url)) throw new PermissionDenied();
            await run(['openurl', udid, data.url]);
          } else if (action === 'location') {
            const data = z
              .object({
                latitude: z.number().min(-90).max(90),
                longitude: z.number().min(-180).max(180),
              })
              .parse(await body(req));
            await run(['location', udid, 'set', `${data.latitude},${data.longitude}`]);
          } else if (action === 'appearance') {
            const data = z.object({ appearance: z.enum(['light', 'dark']) }).parse(await body(req));
            await run(['ui', udid, 'appearance', data.appearance]);
          }
          return json(res, 200, { ok: true });
        }
        if (pathname === '/command' && req.method === 'POST') {
          const { args, confirmed } = commandSchema.parse(await body(req));
          commandArgs = args;
          permit();
          if (args.some((a) => /\0/.test(a)) || args[0].startsWith('-'))
            throw new Error('Enter a simctl subcommand, without xcrun or simctl.');
          if (['erase', 'delete', 'delete_cache', 'runtime'].includes(args[0]) && !confirmed)
            return json(res, 409, {
              error: 'Confirm this command to change or delete simulator data.',
              confirmationRequired: true,
            });
          return json(res, 200, { output: String(await run(args)) });
        }
        json(res, 404, { error: 'Unknown host action.' });
      } catch (e) {
        if (e instanceof RetirementError) cleanupFailures.push(e);
        if (e instanceof AuthorizationRequired) return json(res, 401, authorizationRequired);
        if (e instanceof PermissionDenied) return json(res, 403, permissionDenied);
        const error = e as Error & { stderr?: string };
        json(res, 400, { error: (error.stderr || error.message).slice(0, 3000) });
      } finally {
        forgetRequest();
        res.off('close', forgetRequest);
      }
    }),
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
    if (shuttingDown || req.headers.origin || !clientId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'https://localhost');
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const udid = url.pathname.match(/^\/stream\/([^/]+)$/)?.[1]?.toUpperCase();
    if (!uuid.safeParse(udid).success) {
      socket.destroy();
      return;
    }
    try {
      requirePermission(clients.get(clientId)!.permissions, 'view', udid);
    } catch {
      const payload = JSON.stringify(permissionDenied);
      socket.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`,
      );
      return;
    }
    const revision = clients.get(clientId)!.permissionRevision;
    const fps = Number(url.searchParams.get('fps') ?? 30);
    if (![15, 30, 60].includes(fps)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (
        clients.authenticate(req.headers.authorization) !== clientId ||
        clients.get(clientId)?.permissionRevision !== revision
      ) {
        ws.close(4003, 'Authorization required');
        return;
      }
      clientStreams.set(ws, clientId);
      ws.once('close', () => clientStreams.delete(ws));
      wss.emit('connection', ws, udid, fps, req.headers.authorization);
    });
  });
  wss.on('connection', async (ws: WebSocket, udid: string, fps: number, authorization: string) => {
    const clientId = clientStreams.get(ws);
    const revision = clientId ? clients.get(clientId)?.permissionRevision : undefined;
    const authorized = () =>
      !shuttingDown &&
      !!clientId &&
      clients.authenticate(authorization) === clientId &&
      clients.get(clientId)?.permissionRevision === revision &&
      allowsDevice(clients.get(clientId)!.permissions, udid);
    const permit = (capability: Capability) => {
      if (!authorized()) throw new PermissionDenied();
      requirePermission(clients.get(clientId!)!.permissions, capability, udid);
    };
    const send = (value: object) => {
      if (authorized() && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
    };
    // A quality change or immediate reconnect may arrive while the old companion
    // is draining releases. Wait for that closing lease instead of reporting a
    // different controlling client or starting two companions for the same device.
    ws.on('error', () => {});
    const previous = controllers.get(udid);
    if (previous && previous.readyState !== WebSocket.OPEN) {
      try {
        await controllerClosers.get(udid)?.();
      } catch {
        send({
          type: 'error',
          terminal: true,
          message: 'The previous display could not release its resources. Restart the host.',
        });
        ws.close();
        return;
      }
    }
    if (ws.readyState !== WebSocket.OPEN || !authorized()) return;
    if (controllers.has(udid)) {
      send({
        type: 'error',
        terminal: true,
        message: 'This simulator already has an active display. Disconnect that display first.',
      });
      ws.close();
      return;
    }
    controllers.set(udid, ws);
    let session: Awaited<ReturnType<Backend['session']>> | undefined;
    let pending: ReturnType<Backend['session']> | undefined;
    let discovery: ReturnType<Backend['inventory']> | undefined;
    let closing: Promise<void> | undefined;
    let releaseKeepAwake: (() => void) | undefined;
    const peer = new MediaPeer(
      ws,
      udid,
      fps,
      media,
      (settings) => session?.setVideoSettings?.(settings),
      (capability) => permit(capability),
      clientId,
    );
    const mediaTimer = setInterval(() => peer.tick(), 1000);
    let sentDimensions = '';
    const metadataKey = (metadata: StreamMeta) => JSON.stringify(metadata);
    const abort = new AbortController();
    let alive = true,
      opening = true;
    const cleanup = (): Promise<void> => {
      alive = false;
      abort.abort();
      clearInterval(mediaTimer);
      return (closing ??= (async () => {
        const results = await Promise.allSettled([
          peer.close(),
          (async () => {
            // A rejected startup owns its own partial cleanup. A returned session
            // must report close failures, including when startup finishes late.
            await discovery?.catch((error) => {
              if (error instanceof RetirementError) throw error;
            });
            const active = session ?? (await pending?.catch(() => undefined));
            await active?.close();
          })(),
        ]);
        releaseKeepAwake?.();
        const failures = results
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason);
        if (failures.length) {
          cleanupFailures.push(...failures);
          throw new AggregateError(failures, 'Display cleanup failed. Restart the host.');
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
      void cleanup().catch(() => {});
    });
    ws.on('error', () => {
      void cleanup().catch(() => {});
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
      if (!alive || ws.readyState !== WebSocket.OPEN || !authorized()) return;
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
        const value = JSON.parse(raw.toString());
        if (peer.handle(value)) return;
        const event = inputSchema.parse(value);
        permit('control');
        if (session) session.input(event);
        else if (!opening) throw new Error('The input service is unavailable.');
      } catch (e) {
        send({
          type: 'error',
          ...(e instanceof PermissionDenied ? { code: 'permission_denied' } : {}),
          message: (e as Error).message,
        });
      }
    });
    try {
      if (!authorized()) throw new AuthorizationRequired();
      discovery = backend.inventory(abort.signal);
      const device = (await discovery).devices.find((d) => d.udid.toUpperCase() === udid);
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
      if (!alive || !authorized()) return;
      pending = backend.session(
        udid,
        fps,
        (data) => {
          if (
            alive &&
            authorized() &&
            ws.readyState === WebSocket.OPEN &&
            peer.video.allow(data.length, ws.bufferedAmount)
          ) {
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
      if (!alive || !authorized()) await cleanup();
      else {
        releaseKeepAwake = keepAwake.sessionStarted();
        session.setVideoSettings?.(peer.video.settings);
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
  }).catch(async (error) => {
    await keepAwake.close();
    throw error;
  });
  async function disconnectClient(id: string) {
    for (const [req, request] of clientRequests) {
      if (request.clientId !== id) continue;
      try {
        request.revoke();
      } catch {
        // One failed response must not skip other requests or controller cleanup.
        try {
          req.destroy();
        } catch {
          /* Continue closing the other transports. */
        }
      }
    }
    const matching = [...clientStreams].filter(([, value]) => value === id);
    // Close every transport before starting or awaiting any backend cleanup.
    for (const [ws] of matching) {
      const terminate = () => {
        try {
          ws.terminate();
        } catch {
          /* Backend cleanup must still run if this socket has failed. */
        }
      };
      try {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({
              type: 'error',
              code: clients.get(id) ? 'permission_denied' : 'authorization_required',
              message: clients.get(id)
                ? 'Permissions changed on the Mac. Reconnect to use the current access.'
                : 'Access was revoked on the Mac. Pair with the Mac again to reconnect.',
            }),
          );
        ws.close(
          clients.get(id) ? 4004 : 4003,
          clients.get(id) ? 'Permissions changed' : 'Authorization revoked',
        );
      } catch {
        terminate();
      }
      const timeout = setTimeout(terminate, streamCloseTimeout);
      timeout.unref();
      ws.once('close', () => clearTimeout(timeout));
    }
    // A stalled or failed companion cannot prevent the other cleanups or block local admin.
    // Retain its controller lease until cleanup actually finishes.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(
          matching.map(([ws]) => Promise.resolve().then(() => socketClosers.get(ws)?.())),
        ),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, streamCloseTimeout);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  let closeAdmin: () => Promise<void>;
  try {
    closeAdmin = await clientAdminServer(
      options.directory,
      tracked(async (request: unknown) => {
        if (shuttingDown) throw new Error('The Mac host is stopping.');
        const data = z
          .discriminatedUnion('action', [
            z.object({ action: z.literal('list') }),
            z.object({ action: z.literal('status') }),
            z.object({ action: z.literal('keep-awake'), enabled: z.boolean() }),
            z.object({ action: z.literal('revoke'), id: uuid }),
            z.object({ action: z.literal('pairing') }),
            z.object({
              action: z.literal('permissions'),
              id: uuid,
              expectedRevision: z.number().int().nonnegative().safe(),
              permissions: clientPermissionsSchema,
            }),
          ])
          .parse(request);
        if (data.action === 'status') {
          const { token: _token, ...publicStatus } = status;
          return {
            ...publicStatus,
            pid: process.pid,
            mode: process.env.SIM_RELAY_BACKGROUND === '1' ? 'background' : 'foreground',
            keepAwake: keepAwake.snapshot(),
          };
        }
        if (data.action === 'keep-awake') {
          await keepAwake.setEnabled(data.enabled);
          return keepAwake.snapshot();
        }
        if (data.action === 'pairing')
          return { token: clients.pairingToken, fingerprint: credentials.fingerprint };
        if (data.action === 'list')
          return clients.list(
            (id) => [...clientStreams.values()].filter((value) => value === id).length,
          );
        if (data.action === 'permissions') {
          await clients.setPermissions(data.id, data.expectedRevision, data.permissions);
          await disconnectClient(data.id);
          return clients
            .list((id) => [...clientStreams.values()].filter((value) => value === id).length)
            .find((client) => client.id === data.id);
        }
        await clients.revoke(data.id);
        await disconnectClient(data.id);
        return { revoked: data.id };
      }),
    );
  } catch (error) {
    shuttingDown = true;
    for (const ws of wss.clients) ws.terminate();
    for (const request of clientRequests.values()) request.revoke();
    const networkClosed = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    wss.close();
    await retirementDeadline(
      Promise.allSettled([
        networkClosed,
        keepAwake.close(),
        ...[...streamClosers].map((close) => close()),
        ...pendingHandlers,
      ]),
      shutdownTimeoutMs,
    );
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
  let closingHost: Promise<void> | undefined;
  return {
    status,
    server,
    close(): Promise<void> {
      return (closingHost ??= (async () => {
        shuttingDown = true;
        for (const ws of wss.clients) ws.terminate();
        for (const request of clientRequests.values()) {
          try {
            request.revoke();
          } catch (error) {
            cleanupFailures.push(error);
          }
        }
        // Stop accepting work and destroy even unauthenticated/incomplete uploads
        // before joining handlers. Keep handler ownership after transports disappear.
        const networkClosed = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
        const advertisementsClosed = new Promise<void>((resolve) => {
          bonjour?.unpublishAll(() => {
            bonjour.destroy();
            resolve();
          });
          if (!bonjour) resolve();
        });
        wss.close();
        const results = await retirementDeadline(
          Promise.allSettled([
            closeAdmin(),
            networkClosed,
            advertisementsClosed,
            keepAwake.close(),
            ...[...streamClosers].map((close) => close()),
            ...pendingHandlers,
          ]),
          shutdownTimeoutMs,
        );
        for (const result of results) {
          if (result.status === 'rejected') cleanupFailures.push(result.reason);
        }
        if (cleanupFailures.length)
          throw new AggregateError(cleanupFailures, 'Host resources did not retire cleanly.');
      })());
    },
  };
}
