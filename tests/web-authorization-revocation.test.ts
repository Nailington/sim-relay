import test from 'node:test';
import assert from 'node:assert/strict';
import http, { type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startHost, type Backend } from '../src/host/server';
import { probeHost, pairRemoteClient } from '../src/electron/remote';
import { startWeb } from '../src/web/server';
import type { Profile } from '../src/shared/types';

const udid = '218F5525-50CF-4313-8F44-D58D64811D38';
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for browser request.')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-web-authorization-'));
  const commands: string[][] = [];
  const backend: Backend = {
    inventory: async () => ({ devices: [], runtimes: [], devicetypes: [] }),
    run: async (args) => {
      commands.push(args);
      return '';
    },
    session: async () => {
      throw new Error('No simulator needed');
    },
  };
  const host = await startHost({
    directory,
    port: 0,
    bind: '127.0.0.1',
    advertise: false,
    backend,
    info: {
      name: 'Pinned test Mac',
      version: '0.1.5',
      platform: 'macOS',
      companion: true,
      xcode: true,
    },
  });
  const url = `https://127.0.0.1:${(host.server.address() as { port: number }).port}`;
  const probe = await probeHost(url);
  const initial: Profile = {
    id: randomUUID(),
    name: probe.info.name,
    url,
    source: 'saved',
    certificate: probe.certificate,
    fingerprint: probe.fingerprint,
    token: host.status.token!,
  };
  const profile = await pairRemoteClient(initial, probe, 'Browser regression');
  const web = await startWeb({
    port: 0,
    directory,
    allowedHosts: [url],
    users: { alice: 'alice-test-password-long', bob: 'bob-test-password-long' },
  });
  // Keep the real HTTP/TLS handlers and track their completion, so an early 401
  // cannot hide a later dispatch when a suspended body/probe is finally released.
  const webHandler = web.server.listeners('request')[0];
  const handled = new Map<string, Promise<void>>();
  web.server.removeListener('request', webHandler);
  web.server.on('request', (req, res) => {
    handled.set(req.url!, Promise.resolve(webHandler(req, res)));
  });
  const hostHandler = host.server.listeners('request')[0];
  host.server.removeListener('request', hostHandler);
  let intercept: ((req: IncomingMessage, res: ServerResponse) => boolean) | undefined;
  const hostPaths: string[] = [];
  host.server.on('request', (req, res) => {
    hostPaths.push(req.url!);
    if (!intercept?.(req, res)) void hostHandler(req, res);
  });
  const requests: ClientRequest[] = [];
  const identities = new Map<string, string>();
  const post = (route: string, value: unknown, cookie = '') =>
    fetch(`${web.origin}/api/${route}`, {
      method: 'POST',
      headers: {
        Origin: web.origin,
        Cookie: cookie,
        'Content-Type': 'application/json',
        ...(cookie ? { 'X-Sim-Relay-User': encodeURIComponent(identities.get(cookie)!) } : {}),
      },
      body: JSON.stringify(value),
    });
  return {
    web,
    host,
    profile,
    initial,
    commands,
    hostPaths,
    handled,
    post,
    intercept(fn: typeof intercept) {
      intercept = fn;
    },
    async login(user = 'alice', cookie = '') {
      const response = await post(
        'login',
        { user, password: `${user}-test-password-long` },
        cookie,
      );
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      const next = response.headers.get('set-cookie')!.split(';')[0];
      identities.set(next, user);
      return next;
    },
    async pending(
      route: string,
      payload: string,
      cookie: string,
      extra: Record<string, string> = {},
    ) {
      const received = deferred();
      const onRequest = (req: IncomingMessage) => {
        if (req.url === `/api/${route}`) {
          web.server.off('request', onRequest);
          received.resolve();
        }
      };
      web.server.on('request', onRequest);
      let request!: ClientRequest;
      const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
        request = http.request(
          `${web.origin}/api/${route}`,
          {
            method: 'POST',
            headers: {
              Origin: web.origin,
              Cookie: cookie,
              'X-Sim-Relay-User': encodeURIComponent(identities.get(cookie)!),
              'Content-Length': Buffer.byteLength(payload),
              ...extra,
            },
          },
          (res) => {
            let body = '';
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode!, body }));
            res.on('error', reject);
          },
        );
        request.on('error', reject);
        request.flushHeaders();
      });
      requests.push(request);
      // Attach a handler immediately: tests deliberately hold the response promise.
      void response.catch(() => {});
      await within(received.promise);
      return { request, response };
    },
    async close() {
      for (const request of requests) request.destroy();
      await web.close();
      await host.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test(
  'logout rejects a flushed authenticated erase request before its delayed body and isolates another user',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    try {
      const alice = await f.login(),
        bob = await f.login('bob');
      const payload = JSON.stringify({
        profile: f.profile,
        method: 'POST',
        path: '/command',
        body: { args: ['erase', udid], confirmed: true },
      });
      const pending = await f.pending('request', payload, alice);
      const finished = f.handled.get('/api/request')!;
      assert.equal((await f.post('logout', {}, alice)).status, 200);
      // Reproduce the original sequence exactly: logout completes, then the body arrives.
      pending.request.end(payload);
      assert.equal((await within(pending.response)).status, 401);
      await within(finished);
      assert.deepEqual(f.commands, []);
      assert.equal(f.hostPaths.includes('/command'), false);
      assert.equal(
        (await fetch(f.web.origin + '/api/session', { headers: { Cookie: alice } })).status,
        401,
      );
      const other = await f.post(
        'request',
        { profile: f.profile, method: 'GET', path: '/devices' },
        bob,
      );
      assert.equal(other.status, 200);
      await other.arrayBuffer();
    } finally {
      await f.close();
    }
  },
);

for (const route of ['upload', 'recording-download', 'probe', 'pair']) {
  test(`logout immediately rejects an unfinished ${route} body`, { timeout: 15000 }, async () => {
    const f = await fixture();
    try {
      const cookie = await f.login();
      const payload =
        route === 'upload'
          ? 'delayed app archive'
          : JSON.stringify({
              profile: f.initial,
              url: f.profile.url,
              recording: { id: randomUUID(), ticket: 'a'.repeat(64), bytes: 64 },
            });
      const pending = await f.pending(
        route,
        payload,
        cookie,
        route === 'upload'
          ? {
              'X-Sim-Relay-Profile': Buffer.from(JSON.stringify(f.profile)).toString('base64'),
              'X-Sim-Relay-Device': udid,
            }
          : {},
      );
      const finished = f.handled.get(`/api/${route}`)!;
      assert.equal((await f.post('logout', {}, cookie)).status, 200);
      // Cancellation must answer even if the sender never supplies its body.
      assert.equal((await within(pending.response)).status, 401);
      pending.request.end(payload);
      await within(finished);
      assert.deepEqual(f.hostPaths, []);
      assert.deepEqual(f.commands, []);
    } finally {
      await f.close();
    }
  });
}

test(
  'logout between a real TLS probe and pairing prevents credential dispatch',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    const reached = deferred(),
      release = deferred();
    let probeDone: Promise<void> | undefined;
    try {
      const cookie = await f.login();
      f.intercept((req, res) => {
        if (req.url !== '/info') return false;
        reached.resolve();
        probeDone = release.promise.then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(f.host.status.info));
        });
        return true;
      });
      const pairing = f.post('pair', { profile: f.initial }, cookie);
      await within(reached.promise);
      const finished = f.handled.get('/api/pair')!;
      assert.equal((await f.post('logout', {}, cookie)).status, 200);
      const response = await within(pairing);
      assert.equal(response.status, 401);
      await response.arrayBuffer();
      release.resolve();
      await probeDone;
      await within(finished);
      assert.deepEqual(f.hostPaths, ['/info']);
    } finally {
      release.resolve();
      await f.close();
    }
  },
);

for (const replacement of ['alice', 'bob']) {
  test(
    `successful ${replacement} login replaces only the previous browser session and cancels its pending request`,
    { timeout: 15000 },
    async () => {
      const f = await fixture();
      try {
        const alice = await f.login(),
          otherAlice = await f.login(),
          bob = await f.login('bob');
        const payload = JSON.stringify({
          profile: f.profile,
          method: 'POST',
          path: '/command',
          body: { args: ['erase', udid], confirmed: true },
        });
        const pending = await f.pending('request', payload, alice);
        const finished = f.handled.get('/api/request')!;
        const next = await f.login(replacement, alice);
        assert.notEqual(next, alice);
        assert.equal((await within(pending.response)).status, 401);
        pending.request.end(payload);
        await within(finished);
        assert.deepEqual(f.commands, []);
        for (const cookie of [otherAlice, bob, next])
          assert.equal(
            (await fetch(f.web.origin + '/api/session', { headers: { Cookie: cookie } })).status,
            200,
          );
        assert.equal(
          (await fetch(f.web.origin + '/api/session', { headers: { Cookie: alice } })).status,
          401,
        );
      } finally {
        await f.close();
      }
    },
  );
}

test(
  'session expiry immediately cancels an unfinished body without another authentication request',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture();
    try {
      // Advance the production session lifetime, while retaining real HTTP sockets.
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
      const cookie = await f.login();
      const payload = JSON.stringify({
        profile: f.profile,
        method: 'POST',
        path: '/command',
        body: { args: ['erase', udid], confirmed: true },
      });
      const pending = await f.pending('request', payload, cookie);
      const finished = f.handled.get('/api/request')!;
      t.mock.timers.tick(12 * 60 * 60 * 1000);
      t.mock.timers.reset();
      assert.equal((await within(pending.response)).status, 401);
      pending.request.end(payload);
      await within(finished);
      assert.deepEqual(f.commands, []);
      assert.deepEqual(f.hostPaths, []);
    } finally {
      t.mock.timers.reset();
      await f.close();
    }
  },
);

test(
  'authenticated POSTs require captured workspace identity and stale Alice logout leaves Bob signed in',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    try {
      const bob = await f.login('bob');
      for (const route of ['request', 'probe', 'pair', 'upload', 'recording-download', 'logout']) {
        for (const identity of [undefined, 'alice', '%invalid']) {
          const response = await fetch(`${f.web.origin}/api/${route}`, {
            method: 'POST',
            headers: {
              Origin: f.web.origin,
              Cookie: bob,
              ...(identity === undefined ? {} : { 'X-Sim-Relay-User': identity }),
            },
            body: JSON.stringify({ profile: f.profile, method: 'GET', path: '/devices' }),
          });
          assert.equal(response.status, 401, `${route} rejects ${identity}`);
          assert.equal(
            ((await response.json()) as { code: string }).code,
            'authorization_required',
          );
        }
      }
      assert.deepEqual(f.hostPaths, []);
      assert.equal(
        (await fetch(f.web.origin + '/api/session', { headers: { Cookie: bob } })).status,
        200,
      );
      assert.equal(
        (await f.post('request', { profile: f.profile, method: 'GET', path: '/devices' }, bob))
          .status,
        200,
      );
    } finally {
      await f.close();
    }
  },
);

test('logout aborts an already-dispatched TLS request', { timeout: 15000 }, async () => {
  const f = await fixture();
  const received = deferred(),
    disconnected = deferred();
  try {
    const cookie = await f.login();
    f.intercept((req, res) => {
      if (req.url !== '/devices') return false;
      res.once('close', () => disconnected.resolve());
      received.resolve();
      return true;
    });
    const pending = f.post(
      'request',
      { profile: f.profile, method: 'GET', path: '/devices' },
      cookie,
    );
    await within(received.promise);
    const finished = f.handled.get('/api/request')!;
    assert.equal((await f.post('logout', {}, cookie)).status, 200);
    assert.equal((await within(pending)).status, 401);
    await within(disconnected.promise);
    await within(finished);
    assert.deepEqual(
      f.hostPaths,
      ['/devices'],
      'the dispatched host request existed but its transport was cancelled',
    );
  } finally {
    await f.close();
  }
});

for (const started of [false, true]) {
  test(
    `logout ${started ? 'truncates a started' : 'returns 401 before headers for a pending'} recording download`,
    { timeout: 15000 },
    async () => {
      const f = await fixture();
      const received = deferred(),
        disconnected = deferred();
      let request: ClientRequest | undefined;
      try {
        const cookie = await f.login();
        const recording = { id: randomUUID(), ticket: 'a'.repeat(64), bytes: 64 };
        const issued = await f.post(
          'recording-download',
          { profile: f.profile, recording },
          cookie,
        );
        assert.equal(issued.status, 200);
        const { path: download } = (await issued.json()) as { path: string };
        f.intercept((req, res) => {
          if (req.url !== `/recordings/${recording.id}`) return false;
          assert.equal(req.headers.authorization, `Bearer ${f.profile.token}`);
          assert.equal(req.headers['x-recording-ticket'], recording.ticket);
          res.once('close', () => disconnected.resolve());
          if (started) {
            res.writeHead(200, { 'Content-Length': recording.bytes });
            res.write(Buffer.alloc(4));
          }
          received.resolve();
          return true;
        });
        const firstBytes = deferred();
        const response = new Promise<IncomingMessage>((resolve, reject) => {
          request = http.get(f.web.origin + download, { headers: { Cookie: cookie } }, (res) => {
            res.once('data', () => firstBytes.resolve());
            resolve(res);
          });
          request.on('error', reject);
        });
        void response.catch(() => {});
        await within(received.promise);
        const finished = f.handled.get(download)!;
        let incoming: IncomingMessage | undefined;
        const ended = deferred<string>();
        if (started) {
          incoming = await within(response);
          incoming.once('aborted', () => ended.resolve('aborted'));
          incoming.on('error', () => {});
          incoming.once('end', () => ended.resolve('end'));
          await within(firstBytes.promise);
        }
        assert.equal((await f.post('logout', {}, cookie)).status, 200);
        if (started) {
          assert.equal(incoming!.statusCode, 200, 'headers were already sent');
          assert.equal(
            await within(ended.promise),
            'aborted',
            'partial download must not complete',
          );
        } else {
          incoming = await within(response);
          assert.equal(incoming.statusCode, 401);
          incoming.resume();
        }
        await within(disconnected.promise);
        await within(finished);
      } finally {
        request?.destroy();
        await f.close();
      }
    },
  );
}

test(
  'one failed revocation response cannot skip other pending requests or browser socket cleanup',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    let socket: WebSocket | undefined;
    try {
      const cookie = await f.login();
      socket = new WebSocket(f.web.origin.replace('http:', 'ws:') + '/api/stream', {
        headers: { Origin: f.web.origin, Cookie: cookie },
      });
      await once(socket, 'open');
      const closed = once(socket, 'close');
      f.web.server.on('request', (req, res) => {
        if (req.url !== '/api/request?failed') return;
        const setHeader = res.setHeader.bind(res);
        res.setHeader = (name, value) => {
          if (name === 'Connection') throw new Error('Simulated failed response');
          return setHeader(name, value);
        };
      });
      const payload = JSON.stringify({
        profile: f.profile,
        method: 'POST',
        path: '/command',
        body: { args: ['erase', udid], confirmed: true },
      });
      const failed = await f.pending('request?failed', payload, cookie);
      const failedDone = f.handled.get('/api/request?failed')!;
      const pending = await f.pending('request', payload, cookie);
      const finished = f.handled.get('/api/request')!;
      assert.equal((await f.post('logout', {}, cookie)).status, 200);
      await assert.rejects(within(failed.response), /socket hang up|ECONNRESET/);
      assert.equal((await within(pending.response)).status, 401);
      await within(closed);
      failed.request.end(payload);
      pending.request.end(payload);
      await within(Promise.all([failedDone, finished]));
      assert.deepEqual(f.commands, []);
      assert.equal(
        (await fetch(f.web.origin + '/api/session', { headers: { Cookie: cookie } })).status,
        401,
      );
    } finally {
      socket?.terminate();
      await f.close();
    }
  },
);

test(
  'initial websocket identity must match the cookie before any profile is forwarded over TLS',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    const sockets: WebSocket[] = [];
    try {
      const cookie = await f.login('bob');
      for (const user of [undefined, 'alice']) {
        const socket = new WebSocket(f.web.origin.replace('http:', 'ws:') + '/api/stream', {
          headers: { Origin: f.web.origin, Cookie: cookie },
        });
        sockets.push(socket);
        await once(socket, 'open');
        const message = once(socket, 'message'),
          closed = once(socket, 'close');
        socket.send(JSON.stringify({ profile: f.profile, udid, fps: 30, user }));
        const error = JSON.parse((await within(message))[0].toString());
        assert.equal(error.code, 'authorization_required');
        assert.equal(error.terminal, true);
        assert.equal((await within(closed))[0], 4003);
      }
      assert.deepEqual(f.hostPaths, []);
      assert.equal(
        (await fetch(f.web.origin + '/api/session', { headers: { Cookie: cookie } })).status,
        200,
      );
    } finally {
      for (const socket of sockets) socket.terminate();
      await f.close();
    }
  },
);
