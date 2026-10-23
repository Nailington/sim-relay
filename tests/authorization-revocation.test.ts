import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { once } from 'node:events';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startHost, type Backend } from '../src/host/server';
import { clientAdminRequest } from '../src/host/client-admin';
import { pairRemoteClient, probeHost, remoteRequest, tlsOptions } from '../src/electron/remote';
import type { Profile } from '../src/shared/types';

const devices = [
  '218F5525-50CF-4313-8F44-D58D64811D38',
  '218F5525-50CF-4313-8F44-D58D64811D39',
  '218F5525-50CF-4313-8F44-D58D64811D40',
  '218F5525-50CF-4313-8F44-D58D64811D41',
];
const metadata = { width: 100, height: 200, widthPoints: 100, heightPoints: 200 };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Timed out waiting for host action.')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
async function waitFor(check: () => Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for filesystem cleanup.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture(overrides: Partial<Backend> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-authorization-'));
  const commands: string[][] = [];
  const backend: Backend = {
    inventory: async () => ({ devices: [], runtimes: [], devicetypes: [] }),
    run: async (args) => {
      commands.push(args);
      return '';
    },
    session: async () => ({ metadata, input() {}, async close() {} }),
    ...overrides,
  };
  const host = await startHost({
    directory,
    port: 0,
    bind: '127.0.0.1',
    advertise: false,
    backend,
    info: { name: 'Test Mac', version: '0.1.5', platform: 'macOS', companion: true, xcode: true },
  });
  // Observe completion of the real asynchronous request handler, including work after
  // an early revocation response, so assertions cannot race suspended backend work.
  const handler = host.server.listeners('request')[0];
  const requests = new Map<string, Promise<void>>();
  host.server.removeListener('request', handler);
  host.server.on('request', (req, res) => {
    requests.set(req.url ?? '/', Promise.resolve(handler(req, res)));
  });
  const url = `https://127.0.0.1:${(host.server.address() as { port: number }).port}`;
  const probe = await probeHost(url);
  const sockets: WebSocket[] = [];
  return {
    host,
    url,
    commands,
    handled(pathname: string) {
      const request = requests.get(pathname);
      assert.ok(request, `No request received for ${pathname}`);
      return request;
    },
    async pair(name: string) {
      const profile = await pairRemoteClient(
        {
          id: name,
          name,
          url,
          source: 'saved',
          certificate: probe.certificate,
          fingerprint: probe.fingerprint,
          token: host.status.token!,
        },
        probe,
        name,
      );
      const clients = (await clientAdminRequest(directory, { action: 'list' })) as {
        id: string;
        name: string;
      }[];
      return { profile, id: clients.find((client) => client.name === name)!.id };
    },
    revoke(id: string) {
      return clientAdminRequest(directory, { action: 'revoke', id });
    },
    async connect(profile: Profile, udid: string) {
      const ws = new WebSocket(`${url.replace('https:', 'wss:')}/stream/${udid}`, {
        ...tlsOptions(profile),
        headers: { Authorization: `Bearer ${profile.token}` },
      });
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => {
        ws.on('message', (raw, binary) => {
          if (!binary && JSON.parse(raw.toString()).type === 'metadata') resolve();
        });
        ws.once('error', reject);
      });
      return ws;
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      await host.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test(
  'revocation invalidates an authenticated TLS request whose confirmed erase body is delayed',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    let request: ReturnType<typeof https.request> | undefined;
    try {
      const { profile, id } = await f.pair('Delayed sender');
      const payload = JSON.stringify({ args: ['erase', devices[0]], confirmed: true });
      const received = deferred();
      f.host.server.once('request', () => {
        received.resolve();
      });
      const response = new Promise<{ status: number; code?: string }>((resolve, reject) => {
        request = https.request(
          `${f.url}/command`,
          {
            ...tlsOptions(profile),
            method: 'POST',
            headers: {
              Authorization: `Bearer ${profile.token}`,
              'Content-Length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            res.on('end', () => {
              resolve({ status: res.statusCode!, code: JSON.parse(data).code });
            });
            res.on('error', reject);
          },
        );
        request.on('error', reject);
        request.flushHeaders();
      });
      await received.promise;
      await f.revoke(id);
      // Revocation must finish the response without waiting for the peer's body.
      assert.deepEqual(await within(response), { status: 401, code: 'authorization_required' });
      request!.end(payload);
      assert.deepEqual(f.commands, []);
    } finally {
      request?.destroy();
      await f.close();
    }
  },
);

test(
  'revocation closes every matching WSS stream and bounds admin cleanup when one close stalls and another fails',
  { timeout: 15000 },
  async () => {
    const stalled = deferred();
    const started = deferred();
    const released: string[] = [],
      inputs: string[] = [];
    const f = await fixture({
      session: async (udid) => ({
        metadata,
        input: () => {
          inputs.push(udid);
        },
        close: async () => {
          released.push(udid);
          if (udid === devices[0]) {
            started.resolve();
            await stalled.promise;
          }
          if (udid === devices[1]) throw new Error('Cleanup failed');
        },
      }),
    });
    try {
      const a = await f.pair('Revoked client'),
        b = await f.pair('Other client');
      const matching = [];
      for (const udid of devices.slice(0, 3)) matching.push(await f.connect(a.profile, udid));
      const other = await f.connect(b.profile, devices[3]);
      const closed = matching.map((ws) => once(ws, 'close'));
      const revoke = f.revoke(a.id);
      // Attach rejection handling before checking the streams so a failed assertion can safely clean up.
      void revoke.catch(() => {});
      await started.promise;
      for (const ws of matching) {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'button', button: 'HOME' }));
      }
      other.send(JSON.stringify({ type: 'button', button: 'HOME' }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(
        inputs,
        [devices[3]],
        'revoked streams must stop input before cleanup completes',
      );
      assert.deepEqual(
        released,
        devices.slice(0, 3),
        'all matching cleanups must start concurrently',
      );
      assert.deepEqual(await within(revoke, 2500), { revoked: a.id });
      assert.ok((await Promise.all(closed)).every(([code]) => code === 4003));
      assert.equal(other.readyState, WebSocket.OPEN);
      await remoteRequest(b.profile, 'GET', '/devices');
      await assert.rejects(remoteRequest(a.profile, 'GET', '/devices'), /no longer authorized/);
    } finally {
      stalled.resolve();
      await f.close();
    }
  },
);

test(
  'revocation prevents backend dispatch after each delayed TLS upload',
  { timeout: 15000 },
  async (t) => {
    let inventories = 0;
    const f = await fixture({
      inventory: async () => {
        inventories++;
        return { devices: [], runtimes: [], devicetypes: [] };
      },
    });
    const cases: [string, unknown][] = [
      [
        '/devices',
        {
          name: 'New phone',
          deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
          runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
        },
      ],
      [`/devices/${devices[0]}/text`, { text: 'revoked input' }],
      [`/devices/${devices[0]}/url`, { url: 'https://example.com' }],
      [`/devices/${devices[0]}/location`, { latitude: 10, longitude: 20 }],
      [`/devices/${devices[0]}/appearance`, { appearance: 'dark' }],
      [
        `/devices/${devices[0]}/install`,
        Buffer.from(zipSync({ 'Fixture.app/Info.plist': strToU8('fixture') })),
      ],
    ];
    try {
      for (const [pathname, data] of cases)
        await t.test(pathname, async () => {
          const { profile, id } = await f.pair(pathname);
          const payload = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
          let request: ReturnType<typeof https.request> | undefined;
          const received = deferred();
          f.host.server.once('request', () => {
            received.resolve();
          });
          const response = new Promise<number>((resolve, reject) => {
            request = https.request(
              `${f.url}${pathname}`,
              {
                ...tlsOptions(profile),
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${profile.token}`,
                  'Content-Length': payload.length,
                },
              },
              (res) => {
                res.resume();
                res.once('end', () => {
                  resolve(res.statusCode!);
                });
                res.once('error', reject);
              },
            );
            request.on('error', reject);
            // Start, but do not finish, the upload; both JSON and ZIP bodies must be invalidated.
            request.write(payload.subarray(0, 1));
          });
          try {
            await received.promise;
            const uploadHandled = f.handled(pathname);
            await f.revoke(id);
            request!.end(payload.subarray(1));
            assert.equal(await within(response), 401);
            await within(uploadHandled);
            assert.deepEqual(f.commands, []);
            assert.equal(inventories, 0);
          } finally {
            request?.destroy();
          }
        });
    } finally {
      await f.close();
    }
  },
);

test(
  'revocation revalidates after asynchronous inventory and between boot operations',
  { timeout: 15000 },
  async (t) => {
    for (const stage of ['create inventory', 'boot inventory', 'boot command'])
      await t.test(stage, async () => {
        const entered = deferred(),
          resume = deferred();
        const commands: string[][] = [];
        const inventory = {
          devices: [{ udid: devices[0], name: 'Phone', state: 'Shutdown', runtime: 'iOS 26' }],
          runtimes: [
            {
              identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
              name: 'iOS 26',
              version: '26',
              isAvailable: true,
            },
          ],
          devicetypes: [
            { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', name: 'iPhone 17' },
          ],
        };
        const f = await fixture({
          inventory: async () => {
            if (stage.endsWith('inventory')) {
              entered.resolve();
              await resume.promise;
            }
            return inventory;
          },
          run: async (args) => {
            commands.push(args);
            if (stage === 'boot command' && args[0] === 'boot') {
              entered.resolve();
              await resume.promise;
            }
            return '';
          },
        });
        try {
          const { profile, id } = await f.pair(stage);
          const request = stage.startsWith('create')
            ? remoteRequest(profile, 'POST', '/devices', {
                name: 'New phone',
                deviceType: inventory.devicetypes[0].identifier,
                runtime: inventory.runtimes[0].identifier,
              })
            : remoteRequest(profile, 'POST', `/devices/${devices[0]}/boot`);
          // Observe rejection immediately because revocation can respond before the suspended backend resumes.
          const denied = assert.rejects(request, /no longer authorized/);
          await entered.promise;
          const operationHandled = f.handled(
            stage.startsWith('create') ? '/devices' : `/devices/${devices[0]}/boot`,
          );
          await f.revoke(id);
          resume.resolve();
          await within(denied);
          await within(operationHandled);
          assert.deepEqual(commands, stage === 'boot command' ? [['boot', devices[0]]] : []);
        } finally {
          resume.resolve();
          await f.close();
        }
      });
  },
);

test(
  'revocation during archive extraction prevents installation and removes the extracted directory',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    const root = `Revocation-${randomUUID()}.app`;
    const files: Record<string, Uint8Array> = { [`${root}/Info.plist`]: strToU8('fixture') };
    for (let i = 0; i < 1000; i++) files[`${root}/files/${i}.txt`] = strToU8('fixture');
    let extracted: string | undefined;
    let operationHandled: Promise<void> | undefined;
    try {
      const { profile, id } = await f.pair('Archive uploader');
      const request = remoteRequest(
        profile,
        'POST',
        `/devices/${devices[0]}/install`,
        Buffer.from(zipSync(files)),
      );
      const denied = assert.rejects(request, /no longer authorized/);
      await waitFor(async () => {
        for (const entry of await readdir(tmpdir())) {
          if (!entry.startsWith('sim-relay-app-')) continue;
          const directory = path.join(tmpdir(), entry);
          if (
            await stat(path.join(directory, root, 'Info.plist')).then(
              () => true,
              () => false,
            )
          ) {
            extracted = directory;
            return true;
          }
        }
        return false;
      });
      operationHandled = f.handled(`/devices/${devices[0]}/install`);
      await f.revoke(id);
      await within(denied);
      await within(operationHandled, 5000);
      assert.deepEqual(f.commands, []);
      await assert.rejects(stat(extracted!), { code: 'ENOENT' });
    } finally {
      await f.close();
      if (operationHandled) await operationHandled;
      if (extracted) await rm(extracted, { recursive: true, force: true });
    }
  },
);

test(
  'malformed HTTP and authenticated upgrade request targets are rejected without stopping the TLS host',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    try {
      const { profile } = await f.pair('Malformed target sender');
      for (const upgrade of [false, true]) {
        const status = await new Promise<number>((resolve, reject) => {
          const request = https.request(
            f.url,
            {
              ...tlsOptions(profile),
              path: 'http://[',
              headers: {
                Authorization: `Bearer ${profile.token}`,
                ...(upgrade
                  ? {
                      Connection: 'Upgrade',
                      Upgrade: 'websocket',
                      'Sec-WebSocket-Version': '13',
                      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                    }
                  : {}),
              },
            },
            (res) => {
              res.resume();
              res.once('end', () => {
                resolve(res.statusCode!);
              });
              res.once('error', reject);
            },
          );
          request.once('error', reject);
          request.end();
        });
        assert.equal(status, 400);
        await remoteRequest(profile, 'GET', '/devices');
      }
      assert.deepEqual(f.commands, []);
    } finally {
      await f.close();
    }
  },
);
