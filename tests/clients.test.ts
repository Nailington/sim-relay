import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { clientAuthorizations } from '../src/host/clients';
import { clientAdminRequest } from '../src/host/client-admin';
import { startHost, type Backend } from '../src/host/server';
import { pairRemoteClient, probeHost, remoteRequest, tlsOptions } from '../src/electron/remote';
import type { Profile } from '../src/shared/types';

test('single-use pairing migrates legacy access, persists only hashes, and serializes competing exchanges', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-clients-'));
  try {
    await writeFile(path.join(directory, 'token'), 'legacy-shared-token');
    const clients = await clientAuthorizations(directory);
    assert.notEqual(clients.pairingToken, 'legacy-shared-token');
    assert.equal(clients.authenticate('Bearer legacy-shared-token'), undefined);
    const code = clients.pairingToken;
    const results = await Promise.allSettled([
      clients.pair(`Bearer ${code}`, 'Alice laptop'),
      clients.pair(`Bearer ${code}`, 'Bob desktop'),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const successful = results.find((r) => r.status === 'fulfilled')!;
    assert.equal(successful.status, 'fulfilled');
    if (successful.status !== 'fulfilled') throw new Error('Pairing failed.');
    const paired = successful.value;
    assert.equal(clients.authenticate(`Bearer ${paired.token}`), paired.id);
    assert.notEqual(clients.pairingToken, code);
    const saved = await readFile(path.join(directory, 'clients.json'), 'utf8');
    assert.equal(saved.includes(paired.token), false);
    assert.equal(saved.includes(code), false);
    if (process.platform !== 'win32')
      assert.equal((await stat(path.join(directory, 'clients.json'))).mode & 0o777, 0o600);
    const restarted = await clientAuthorizations(directory);
    assert.equal(restarted.authenticate(`Bearer ${paired.token}`), paired.id);
    await restarted.revoke(paired.id);
    assert.equal(restarted.authenticate(`Bearer ${paired.token}`), undefined);
    assert.equal(
      (await clientAuthorizations(directory)).authenticate(`Bearer ${paired.token}`),
      undefined,
    );
    await writeFile(path.join(directory, 'clients.json'), '{broken');
    await assert.rejects(clientAuthorizations(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'local revocation releases only that client and rejects its old credential',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'relay-revoke-'));
    const deviceA = '218F5525-50CF-4313-8F44-D58D64811D38';
    const deviceB = '218F5525-50CF-4313-8F44-D58D64811D39';
    const released: string[] = [],
      inputs: string[] = [];
    const backend: Backend = {
      inventory: async () => ({
        devices: [deviceA, deviceB].map((udid) => ({
          udid,
          name: udid,
          state: 'Booted',
          runtime: 'iOS fake',
        })),
        runtimes: [],
        devicetypes: [],
      }),
      run: async () => '',
      session: async (udid) => ({
        metadata: { width: 100, height: 200, widthPoints: 100, heightPoints: 200 },
        input: () => inputs.push(udid),
        close: async () => {
          released.push(udid);
        },
      }),
    };
    const host = await startHost({
      directory,
      port: 0,
      bind: '127.0.0.1',
      advertise: false,
      backend,
      info: { name: 'Test Mac', version: '0.1.5', platform: 'macOS', companion: true, xcode: true },
    });
    const url = `https://127.0.0.1:${(host.server.address() as { port: number }).port}`;
    const sockets: WebSocket[] = [];
    try {
      const probe = await probeHost(url);
      const pair = async (name: string) =>
        pairRemoteClient(
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
      const oldCode = host.status.token;
      const a = await pair('Alice laptop'),
        b = await pair('Bob desktop');
      await assert.rejects(
        remoteRequest({ ...a, token: oldCode! }, 'GET', '/devices'),
        /authorized/,
      );
      const connect = async (profile: Profile, udid: string) => {
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
      };
      const wsA = await connect(a, deviceA),
        wsB = await connect(b, deviceB);
      const list = (await clientAdminRequest(directory, { action: 'list' })) as {
        id: string;
        name: string;
        activeSessions: number;
      }[];
      assert.equal(list.length, 2);
      assert.ok(list.every((client) => client.activeSessions === 1));
      assert.equal(JSON.stringify(list).includes(a.token), false);
      const closed = once(wsA, 'close');
      await clientAdminRequest(directory, {
        action: 'revoke',
        id: list.find((c) => c.name === a.name)!.id,
      });
      const [code] = await closed;
      assert.equal(code, 4003);
      assert.deepEqual(released, [deviceA]);
      await assert.rejects(remoteRequest(a, 'GET', '/devices'), /no longer authorized/);
      await remoteRequest(b, 'GET', '/devices');
      wsB.send(JSON.stringify({ type: 'button', button: 'HOME' }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(inputs, [deviceB]);
      assert.equal(wsB.readyState, WebSocket.OPEN);
      const restartedAccess = await readFile(path.join(directory, 'clients.json'), 'utf8');
      assert.equal(restartedAccess.includes(a.token), false);
      assert.equal(
        ((await clientAdminRequest(directory, { action: 'list' })) as unknown[]).length,
        1,
      );
    } finally {
      for (const socket of sockets) socket.terminate();
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
