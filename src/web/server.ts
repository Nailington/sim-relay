import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { hostUrl, probeHost, remoteRequest, tlsOptions } from '../electron/remote';
import { inputSchema } from '../host/protocol';
import type { Profile } from '../shared/types';
import { RecordingDownloads } from './recording-download';
import { mediaControlSchema } from './media-control';
import { terminalFailure, SessionFailure } from '../electron/session';
import { createUpdateChecker } from '../shared/update-checker';
import packageMetadata from '../../package.json';
import { recoveryMessages, type RecoveryCode } from '../shared/migration';

const profileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(255),
  url: z.string().max(2048),
  fingerprint: z.string().max(256),
  certificate: z.string().max(16384),
  token: z.string().min(1).max(256),
  source: z.literal('saved'),
  authorizationMode: z.enum(['legacy', 'client']).optional(),
});
const hash = (value: string) => createHash('sha256').update(value).digest();
class WebActionError extends Error {}
class AuthorizationRequired extends Error {}
const authorizationRequired = {
  error: 'Sign in to this hosting service again.',
  code: 'authorization_required',
};
function safeError(error: unknown): string {
  if (error instanceof WebActionError) return error.message;
  const code = (error as { code?: string })?.code;
  if (code && Object.prototype.hasOwnProperty.call(recoveryMessages, code))
    return recoveryMessages[code as RecoveryCode];
  const message = (error as Error).message ?? '';
  if (/certificate|fingerprint|CERT_|TLS|SSL/i.test(message))
    return 'The paired Mac certificate could not be verified. Compare the fingerprint on the Mac and pair again only if you trust the new certificate.';
  if (/authoriz|pairing|credential|revok|401|403/i.test(message))
    return 'This browser is not authorized on the Mac. Get its current pairing code and pair again.';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|reach this Mac|too long/i.test(message))
    return 'Cannot reach the Mac. Keep it awake and sharing, and check the host address, network, and firewall.';
  if (/protocol|compatib/i.test(message))
    return 'The client and Mac host protocols are incompatible. Update Sim Relay on both computers.';
  return 'The Mac could not complete this action. Check its address, pairing, and simulator state, then retry.';
}
const json = (response: ServerResponse, status: number, data: unknown) => {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
};
async function body(request: IncomingMessage, limit = 256 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export interface WebOptions {
  bind?: string;
  port?: number;
  publicOrigin?: string;
  users: Record<string, string>;
  allowedHosts: string[];
  directory: string;
  tls?: { cert: Buffer; key: Buffer };
}

/** Stateless Mac credentials: each request supplies only that browser's pinned profile. */
export async function startWeb(options: WebOptions) {
  const checkUpdates = createUpdateChecker({
    currentVersion: packageMetadata.version,
    platform: 'browser',
    arch: process.arch,
    installation: 'web',
  });
  const users = new Map(
    Object.entries(options.users).map(([name, password]) => {
      if (!name || name.length > 100 || password.length < 16)
        throw new Error('Each web user needs a name and a password of at least 16 characters.');
      return [name, hash(password)] as const;
    }),
  );
  if (!users.size)
    throw new Error('Configure at least one web user before starting browser hosting.');
  const allowed = new Set(options.allowedHosts.map((value) => hostUrl(value).origin));
  if (!allowed.size) throw new Error('Configure the Mac host addresses this relay may reach.');
  const checkHost = (url: string) => {
    const parsed = hostUrl(url);
    if (!allowed.has(parsed.origin))
      throw new WebActionError(
        'This Mac address is not enabled on the hosting service. Ask its owner to add it.',
      );
    return parsed.origin;
  };
  const getProfile = (value: unknown): Profile => {
    const profile = profileSchema.parse(value);
    profile.url = checkHost(profile.url);
    return profile;
  };
  const sessions = new Map<string, { user: string; expires: number }>();
  const expirations = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<IncomingMessage, { id: string; revoke(): void }>();
  const loginAttempts = new Map<string, { count: number; start: number }>();
  const browserSockets = new Map<WebSocket, string>();
  const downloads = new RecordingDownloads();
  const relays = new Set<() => void>();
  const revokeSession = (id: string) => {
    // Delete ownership before touching transports. A failed response must never
    // leave credentials, another request, or a stream authorized.
    sessions.delete(id);
    clearTimeout(expirations.get(id));
    expirations.delete(id);
    for (const [request, active] of pending) {
      if (active.id !== id) continue;
      try {
        active.revoke();
      } catch {
        try {
          request.destroy();
        } catch {
          // Keep revoking credentials and the remaining transports.
        }
      }
    }
    downloads.revoke(id);
    for (const [socket, owner] of browserSockets) {
      if (owner !== id) continue;
      try {
        socket.terminate();
      } catch {
        // Continue revoking the other transports even if one has already failed.
      }
    }
  };
  let origin = options.publicOrigin ? new URL(options.publicOrigin).origin : '';
  if (
    origin &&
    !origin.startsWith('https://') &&
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)
  )
    throw new Error('Remote browser access requires an HTTPS public origin.');
  const cookie = (request: IncomingMessage) =>
    request.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('simrelay_web='))
      ?.slice(13);
  const session = (request: IncomingMessage) => {
    const id = cookie(request),
      value = id && sessions.get(id);
    if (!value || value.expires <= Date.now()) {
      if (id) revokeSession(id);
      return;
    }
    return { value, id: id!, user: value.user, expires: value.expires };
  };
  const authorized = (current: NonNullable<ReturnType<typeof session>>) => {
    if (current.expires <= Date.now()) revokeSession(current.id);
    return sessions.get(current.id) === current.value && users.has(current.user);
  };
  const expectedUser = (request: IncomingMessage) => {
    const encoded = request.headers['x-sim-relay-user'];
    if (typeof encoded !== 'string') return;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return;
    }
  };
  const validHost = (request: IncomingMessage) => request.headers.host === new URL(origin).host;
  const sameOrigin = (request: IncomingMessage) => request.headers.origin === origin;
  const listener = async (request: IncomingMessage, response: ServerResponse) => {
    let forgetRequest = () => {};
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${origin.replace(/^http/, 'ws')}; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
    );
    if (!validHost(request))
      return json(response, 403, { error: 'Open the configured public URL for this deployment.' });
    try {
      const pathname = new URL(request.url ?? '/', origin).pathname;
      const current = session(request);
      if (pathname === '/api/session' && request.method === 'GET')
        return json(response, current ? 200 : 401, { mode: 'web', user: current?.user });
      if (request.method === 'POST' && !sameOrigin(request))
        return json(response, 403, { error: 'Open Sim Relay directly to use this action.' });
      if (pathname === '/api/login' && request.method === 'POST') {
        const key = request.socket.remoteAddress ?? 'unknown';
        const now = Date.now();
        let attempt = loginAttempts.get(key);
        if (!attempt || now - attempt.start > 60_000) {
          if (loginAttempts.size > 4096) loginAttempts.clear();
          attempt = { count: 0, start: now };
          loginAttempts.set(key, attempt);
        }
        if (++attempt.count > 20)
          return json(response, 429, {
            error: 'Too many sign-in attempts. Wait one minute and retry.',
          });
        const data = z
          .object({ user: z.string().max(100), password: z.string().max(1024) })
          .parse(JSON.parse((await body(request, 4096)).toString()));
        const expected = users.get(data.user) ?? hash('invalid-user');
        if (!timingSafeEqual(expected, hash(data.password)) || !users.has(data.user))
          return json(response, 401, { error: 'Check your username and password.' });
        const signedInAt = Date.now();
        for (const [id, value] of sessions) if (value.expires <= signedInAt) revokeSession(id);
        // Successful login rotates this browser's cookie without revoking other browsers.
        const previous = cookie(request);
        if (previous) revokeSession(previous);
        if (sessions.size >= 1000)
          return json(response, 503, {
            error: 'The hosting service has too many active sign-ins. Try again later.',
          });
        const id = randomBytes(32).toString('base64url');
        const expires = signedInAt + 12 * 60 * 60 * 1000;
        sessions.set(id, { user: data.user, expires });
        const expiry = setTimeout(() => revokeSession(id), expires - signedInAt);
        expiry.unref();
        expirations.set(id, expiry);
        response.setHeader(
          'Set-Cookie',
          `simrelay_web=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${origin.startsWith('https:') ? '; Secure' : ''}`,
        );
        return json(response, 200, { user: data.user });
      }
      if (pathname.startsWith('/api/')) {
        if (!current) return json(response, 401, authorizationRequired);
        const user = expectedUser(request);
        if (request.method === 'POST' && user !== current.user)
          return json(response, 401, authorizationRequired);
        if (pathname === '/api/logout' && request.method === 'POST') {
          revokeSession(current.id);
          response.setHeader(
            'Set-Cookie',
            `simrelay_web=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${origin.startsWith('https:') ? '; Secure' : ''}`,
          );
          return json(response, 200, { ok: true });
        }
        const abort = new AbortController();
        pending.set(request, {
          id: current.id,
          revoke() {
            abort.abort();
            if (response.destroyed || response.writableEnded) return;
            if (response.headersSent) {
              // An already-started download cannot be replaced with a 401.
              response.destroy();
              request.destroy();
              return;
            }
            response.setHeader('Connection', 'close');
            response.once('finish', () => request.destroy());
            json(response, 401, authorizationRequired);
          },
        });
        const closed = () => {
          pending.delete(request);
          if (!response.writableFinished) abort.abort();
        };
        response.once('close', closed);
        forgetRequest = () => {
          pending.delete(request);
          response.off('close', closed);
        };
        const authorize = () => {
          if (
            abort.signal.aborted ||
            !authorized(current) ||
            (request.method === 'POST' && expectedUser(request) !== current.user)
          )
            throw new AuthorizationRequired();
        };
        // Recheck ownership and dispatch in the same synchronous turn after
        // every body/probe await. Cancellation cannot undo a command sent earlier.
        const remote = (profile: Profile, method: string, pathname: string, data?: unknown) => {
          authorize();
          return remoteRequest(profile, method, pathname, data, abort.signal);
        };
        authorize();
        if (pathname.startsWith('/api/download/') && request.method === 'GET') {
          if (
            !(await downloads.serve(pathname.slice('/api/download/'.length), current.id, response))
          )
            return json(response, 404, {
              error: 'This download expired. Keep the display connected and choose Save again.',
            });
          return;
        }
        if (request.method !== 'POST')
          return json(response, 405, { error: 'Use POST for this action.' });
        if (pathname === '/api/upload') {
          const encoded = request.headers['x-sim-relay-profile'];
          if (typeof encoded !== 'string' || encoded.length > 32000)
            throw new Error('Choose a paired Mac before uploading.');
          const profile = getProfile(JSON.parse(Buffer.from(encoded, 'base64').toString()));
          const udid = z.string().uuid().parse(request.headers['x-sim-relay-device']);
          await remote(
            profile,
            'POST',
            `/devices/${udid}/install`,
            await body(request, 128 * 1024 * 1024),
          );
          authorize();
          return json(response, 200, { ok: true });
        }
        const data = JSON.parse((await body(request)).toString());
        authorize();
        if (pathname === '/api/updates') {
          const channel = z.enum(['stable', 'preview']).parse(data.channel);
          const result = await checkUpdates(channel);
          authorize();
          return json(response, 200, result);
        }
        if (pathname === '/api/recording-download')
          return json(
            response,
            200,
            downloads.issue(current.id, getProfile(data.profile), data.recording, current.expires),
          );
        if (pathname === '/api/probe') {
          const probe = await probeHost(checkHost(z.string().parse(data.url)));
          authorize();
          return json(response, 200, probe);
        }
        if (pathname === '/api/pair') {
          const profile = getProfile(data.profile);
          // Re-probe the pinned endpoint. Never trust renderer-supplied capability declarations.
          const probe = await probeHost(profile.url);
          authorize();
          if (probe.fingerprint !== profile.fingerprint)
            throw new Error('The Mac certificate changed. Verify its fingerprint and pair again.');
          let paired = profile;
          // Use the cancellable request path for both modern and legacy pairing.
          if (probe.info.clientAuthorization) {
            const result = JSON.parse(
              (
                await remote(profile, 'POST', '/pair', { name: `${current.user} browser` })
              ).toString(),
            );
            authorize();
            if (typeof result.token !== 'string' || !/^[\w-]{43}$/.test(result.token))
              throw new Error('The Mac returned an invalid client credential. Pair again.');
            paired = { ...profile, token: result.token, authorizationMode: 'client' };
          } else {
            try {
              await remote(profile, 'GET', '/devices');
            } catch (error) {
              if (
                error instanceof SessionFailure &&
                ['legacy_pairing', 'authorization_required'].includes(error.code ?? '')
              )
                throw new SessionFailure(
                  recoveryMessages.legacy_code_invalid,
                  true,
                  'legacy_code_invalid',
                );
              throw error;
            }
            authorize();
            paired = { ...profile, authorizationMode: 'legacy' };
          }
          return json(response, 200, paired);
        }
        if (pathname === '/api/request') {
          const profile = getProfile(data.profile);
          const result = await remote(
            profile,
            z.enum(['GET', 'POST']).parse(data.method),
            z.string().max(8192).parse(data.path),
            data.body,
          );
          authorize();
          if (/\/screenshot$/.test(data.path)) {
            response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
            response.end(result);
            return;
          }
          return json(response, 200, JSON.parse(result.toString()));
        }
        return json(response, 404, { error: 'Unknown browser action.' });
      }
      if (request.method !== 'GET') return json(response, 405, { error: 'Unsupported action.' });
      // Only built public assets are served; never expose repository/state files.
      const relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
      if (relative.includes('..') || (!relative.startsWith('assets/') && relative !== 'index.html'))
        return json(response, 404, { error: 'Page not found.' });
      const file = path.resolve(options.directory, relative);
      if (!file.startsWith(path.resolve(options.directory) + path.sep))
        throw new Error('Page not found.');
      const original = await readFile(file);
      const content =
        relative === 'index.html'
          ? Buffer.from(
              original
                .toString()
                .replace(
                  /connect-src [^;]+;/,
                  `connect-src 'self' ${origin.replace(/^http/, 'ws')};`,
                ),
            )
          : original;
      const mime: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
      };
      response.writeHead(200, {
        'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(content);
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof AuthorizationRequired) return json(response, 401, authorizationRequired);
      // Host errors can contain user paths/credentials. The browser receives a safe next step.
      json(response, 400, {
        error: safeError(error),
      });
    } finally {
      forgetRequest();
    }
  };
  const server = options.tls
    ? https.createServer(options.tls, listener)
    : http.createServer(listener);
  server.requestTimeout = 130_000;
  server.headersTimeout = 10_000;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
  });
  server.on('upgrade', (request, socket, head) => {
    const current = session(request);
    if (!validHost(request) || !sameOrigin(request) || !current || request.url !== '/api/stream') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (browser) => {
      browserSockets.set(browser, current.id);
      browser.once('close', () => browserSockets.delete(browser));
      let remote: WebSocket | undefined,
        started = false;
      const close = () => {
        clearTimeout(startup);
        clearInterval(heartbeat);
        remote?.terminate();
        browser.terminate();
        relays.delete(close);
      };
      relays.add(close);
      const startup = setTimeout(close, 15_000);
      let alive = true;
      const heartbeat = setInterval(() => {
        if (!alive || !authorized(current)) {
          close();
          return;
        }
        alive = false;
        browser.ping();
      }, 15_000);
      browser.on('pong', () => {
        alive = true;
      });
      browser.on('error', close);
      browser.once('close', close);
      browser.on('message', (raw, binary) => {
        if (binary || !authorized(current)) {
          close();
          return;
        }
        try {
          const data = JSON.parse(raw.toString());
          if (!started) {
            if (data.user !== current.user) throw new AuthorizationRequired();
            started = true;
            const profile = getProfile(data.profile);
            const udid = z.string().uuid().parse(data.udid);
            const fps = z.union([z.literal(15), z.literal(30), z.literal(60)]).parse(data.fps);
            const url = new URL(`/stream/${udid}?fps=${fps}`, profile.url);
            url.protocol = 'wss:';
            remote = new WebSocket(url, {
              ...tlsOptions(profile),
              headers: { Authorization: `Bearer ${profile.token}` },
              handshakeTimeout: 10_000,
              maxPayload: 16 * 1024 * 1024,
              perMessageDeflate: false,
            });
            remote.on('open', () => clearTimeout(startup));
            remote.on('message', (frame, isBinary) => {
              if (browser.readyState !== WebSocket.OPEN) return;
              if (isBinary && browser.bufferedAmount > 2 * 1024 * 1024) return;
              browser.send(frame, { binary: isBinary });
            });
            remote.on('error', (error) => {
              if (browser.readyState === WebSocket.OPEN)
                browser.send(
                  JSON.stringify({
                    type: 'error',
                    message: safeError(error),
                    terminal: terminalFailure(error),
                  }),
                );
              browser.close(terminalFailure(error) ? 4003 : 1011);
            });
            remote.once('close', (code) => {
              if (browser.readyState === WebSocket.OPEN) browser.close(code === 4003 ? 4003 : 1000);
              remote = undefined;
            });
            return;
          }
          if (remote?.readyState === WebSocket.OPEN) {
            if (remote.bufferedAmount > 64 * 1024) {
              close();
              return;
            }
            remote.send(
              JSON.stringify(
                ['quality', 'video-feedback', 'media-pong', 'media-control'].includes(data?.type)
                  ? mediaControlSchema.parse(data)
                  : inputSchema.parse(data),
              ),
            );
          }
        } catch (error) {
          if (browser.readyState === WebSocket.OPEN) {
            browser.send(
              JSON.stringify({
                type: 'error',
                ...(error instanceof AuthorizationRequired
                  ? { code: authorizationRequired.code, message: authorizationRequired.error }
                  : { message: safeError(error) }),
                terminal: true,
              }),
            );
            browser.close(4003);
          } else close();
        }
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 49301, options.bind ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (!origin)
    origin = `${options.tls ? 'https' : 'http'}://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    server,
    origin,
    async close() {
      for (const id of sessions.keys()) revokeSession(id);
      downloads.revoke();
      for (const close of relays) close();
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
