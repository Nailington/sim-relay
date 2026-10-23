import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { WebSocket } from 'ws';
import { startHost, type Backend } from '../src/host/server';
import { startWeb } from '../src/web/server';
import type { Profile, Probe } from '../src/shared/types';

test(
  'one hosted deployment isolates authenticated browser streams and pins Mac connections',
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'relay-web-'));
    const a = '218F5525-50CF-4313-8F44-D58D64811D38',
      b = '218F5525-50CF-4313-8F44-D58D64811D39';
    const inputs: string[] = [],
      closed: string[] = [];
    const backend: Backend = {
      inventory: async () => ({
        devices: [a, b].map((udid) => ({ udid, name: udid, state: 'Booted', runtime: 'iOS 26' })),
        runtimes: [],
        devicetypes: [],
      }),
      run: async () => '',
      session: async (udid) => ({
        metadata: { width: 100, height: 200, widthPoints: 100, heightPoints: 200 },
        input: () => inputs.push(udid),
        close: async () => {
          closed.push(udid);
        },
      }),
    };
    const host = await startHost({
      directory,
      port: 0,
      bind: '127.0.0.1',
      advertise: false,
      backend,
      info: {
        name: 'Web test Mac',
        version: '0.1.5',
        platform: 'macOS',
        companion: true,
        xcode: true,
      },
    });
    const mac = `https://127.0.0.1:${(host.server.address() as { port: number }).port}`;
    const web = await startWeb({
      port: 0,
      users: { alice: 'alice-test-password-long', bob: 'bob-test-password-long' },
      allowedHosts: [mac],
      directory,
    });
    const sockets: WebSocket[] = [];
    const post = (route: string, value: unknown, cookie = '', origin = web.origin) =>
      fetch(`${web.origin}/api/${route}`, {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
    try {
      const malformed = await new Promise<number>((resolve, reject) => {
        const request = http.request(web.origin, { path: '//%' }, (response) => {
          response.resume();
          resolve(response.statusCode!);
        });
        request.on('error', reject);
        request.end();
      });
      assert.equal(malformed, 400);
      assert.equal(
        (await fetch(web.origin + '/api/session')).status,
        401,
        'service survives malformed request targets',
      );
      assert.equal((await post('probe', { url: mac })).status, 401);
      assert.equal(
        (
          await post(
            'login',
            { user: 'alice', password: 'alice-test-password-long' },
            '',
            'https://evil.example',
          )
        ).status,
        403,
      );
      const login = async (user: string) => {
        const response = await post('login', { user, password: `${user}-test-password-long` });
        assert.equal(response.status, 200);
        const cookie = response.headers.get('set-cookie')!;
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Strict/);
        return cookie.split(';')[0];
      };
      const alice = await login('alice'),
        bob = await login('bob');
      assert.notEqual(alice, bob);
      const probe = (await (await post('probe', { url: mac }, alice)).json()) as Probe;
      const pair = async (cookie: string) => {
        const profile: Profile = {
          id: randomUUID(),
          name: probe.info.name,
          url: mac,
          certificate: probe.certificate,
          fingerprint: probe.fingerprint,
          token: host.status.token!,
          source: 'saved',
        };
        const response = await post('pair', { profile }, cookie);
        assert.equal(response.status, 200);
        return response.json() as Promise<Profile>;
      };
      const profileA = await pair(alice),
        profileB = await pair(bob);
      assert.notEqual(profileA.token, profileB.token);
      const badProfile = { ...profileA, fingerprint: '00:00' };
      assert.equal(
        (await post('request', { profile: badProfile, method: 'GET', path: '/devices' }, alice))
          .status,
        400,
      );
      assert.equal((await post('probe', { url: 'https://127.0.0.1:1' }, alice)).status, 400);
      assert.equal(
        (
          await post(
            'request',
            { profile: profileA, method: 'GET', path: '/devices' },
            alice,
            'https://evil.example',
          )
        ).status,
        403,
      );
      const connect = async (cookie: string, profile: Profile, udid: string) => {
        const ws = new WebSocket(web.origin.replace('http:', 'ws:') + '/api/stream', {
          headers: { Cookie: cookie, Origin: web.origin },
        });
        sockets.push(ws);
        const metadata = new Promise<void>((resolve, reject) => {
          ws.on('message', (data, binary) => {
            if (!binary && JSON.parse(data.toString()).type === 'metadata') resolve();
          });
          ws.once('error', reject);
        });
        await once(ws, 'open');
        ws.send(JSON.stringify({ profile, udid, fps: 30 }));
        await metadata;
        return ws;
      };
      const wsA = await connect(alice, profileA, a),
        wsB = await connect(bob, profileB, b);
      wsA.send(JSON.stringify({ type: 'button', button: 'HOME', udid: b }));
      wsB.send(JSON.stringify({ type: 'button', button: 'LOCK' }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(inputs.sort(), [a, b]);
      const ended = once(wsA, 'close');
      await post('logout', {}, alice);
      await ended;
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.ok(closed.includes(a));
      assert.equal(closed.includes(b), false);
      assert.equal(wsB.readyState, WebSocket.OPEN);
      wsB.send(JSON.stringify({ type: 'button', button: 'HOME' }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(inputs.at(-1), b);
      const session = await (
        await fetch(web.origin + '/api/session', { headers: { Cookie: bob } })
      ).json();
      assert.deepEqual(session, { mode: 'web', user: 'bob' });
      assert.equal(
        (await post('request', { profile: profileA, method: 'GET', path: '/devices' }, alice))
          .status,
        401,
      );
      await writeFile(path.join(directory, 'index.html'), '<html>built app fixture</html>');
      assert.equal((await fetch(web.origin + '/clients.json')).status, 404);
      assert.match(await (await fetch(web.origin)).text(), /built app fixture/);
    } finally {
      for (const socket of sockets) socket.terminate();
      await web.close();
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
