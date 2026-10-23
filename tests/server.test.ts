import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { WebSocket } from 'ws';
import { startHost, type Backend } from '../src/host/server';
import { probeHost, remoteRequest, tlsOptions, pairRemoteClient } from '../src/electron/remote';
import type { Profile, InputEvent } from '../src/shared/types';
import { zipSync, strToU8 } from 'fflate';
import { readFile, stat } from 'node:fs/promises';

test('TLS host: pairing, certificate pinning, lifecycle, command confirmation, and input transport', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'relay-test-'));
  const udid = '218F5525-50CF-4313-8F44-D58D64811D38';
  const commands: string[][] = [],
    inputs: InputEvent[] = [];
  const clipboard: string[] = [];
  let released = false;
  const backend: Backend = {
    inventory: async () => ({
      devices: [{ udid, name: 'Test iPhone', state: 'Shutdown', runtime: 'iOS 26' }],
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
    }),
    run: async (args, binary, stdin) => {
      commands.push(args);
      if (stdin !== undefined) clipboard.push(stdin);
      if (args[0] === 'install')
        assert.equal(await readFile(path.join(args[2], 'Info.plist'), 'utf8'), 'fixture');
      return binary ? Buffer.from([137, 80, 78, 71]) : args[0] === 'create' ? udid : 'completed';
    },
    session: async (_udid, _fps, frame) => {
      setTimeout(() => frame(Buffer.from([255, 216, 1, 255, 217])), 50);
      return {
        metadata: { width: 1206, height: 2622, widthPoints: 402, heightPoints: 874 },
        input: (input) => inputs.push(input),
        close: async () => {
          released = true;
        },
      };
    },
  };
  const host = await startHost({
    directory: dir,
    port: 0,
    bind: '127.0.0.1',
    advertise: false,
    backend,
    info: { name: 'Test Mac', version: '0.1.0', platform: 'macOS', companion: true, xcode: true },
  });
  const url = `https://127.0.0.1:${(host.server.address() as { port: number }).port}`;
  let socket: WebSocket | undefined;
  try {
    const probe = await probeHost(url);
    assert.equal(probe.info.name, 'Test Mac');
    assert.equal(probe.fingerprint, host.status.fingerprint);
    const profile: Profile = await pairRemoteClient({
      id: 'test',
      name: 'Test',
      url,
      certificate: probe.certificate,
      fingerprint: probe.fingerprint,
      token: host.status.token!,
      source: 'saved',
    }, probe, 'Test desktop');
    await assert.rejects(
      remoteRequest({ ...profile, token: 'wrong' }, 'GET', '/devices'),
      /no longer authorized/,
    );
    const deviceList = JSON.parse((await remoteRequest(profile, 'GET', '/devices')).toString());
    assert.equal(deviceList.devices[0].udid, udid);
    await assert.rejects(
      remoteRequest({ ...profile, fingerprint: '00:00' }, 'GET', '/devices'),
      /certificate changed/,
    );
    await remoteRequest(profile, 'POST', `/devices/${udid}/boot`);
    assert.deepEqual(commands.slice(-2), [
      ['boot', udid],
      ['bootstatus', udid, '-b'],
    ]);
    await assert.rejects(
      remoteRequest(profile, 'POST', '/command', { args: ['erase', udid] }),
      /Confirm/,
    );
    assert.equal(
      commands.some((c) => c[0] === 'erase'),
      false,
    );
    await remoteRequest(profile, 'POST', '/command', { args: ['erase', udid], confirmed: true });
    assert.deepEqual(commands.at(-1), ['erase', udid]);
    await remoteRequest(profile, 'POST', `/devices/${udid}/text`, {
      text: 'Unicode 👋\nSecond line',
    });
    assert.deepEqual(clipboard, ['Unicode 👋\nSecond line']);
    await remoteRequest(
      profile,
      'POST',
      `/devices/${udid}/install`,
      Buffer.from(zipSync({ 'Fixture.app/Info.plist': strToU8('fixture') })),
    );
    const installed = commands.at(-1)!;
    assert.equal(installed[0], 'install');
    await assert.rejects(stat(installed[2]));
    await assert.rejects(
      remoteRequest(profile, 'POST', `/devices/${udid}/location`, { latitude: 900, longitude: 0 }),
    );
    const originStatus = await new Promise<number>((resolve, reject) => {
      const req = https.get(
        `${url}/info`,
        { ...tlsOptions(profile), headers: { Origin: 'https://evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on('error', reject);
    });
    assert.equal(originStatus, 403);
    socket = new WebSocket(`${url.replace('https:', 'wss:')}/stream/${udid}?fps=30`, {
      ...tlsOptions(profile),
      headers: { Authorization: `Bearer ${profile.token}` },
    });
    const events: unknown[] = [];
    const connected = new Promise<void>((resolve, reject) => {
      socket!.on('message', (data, binary) => {
        events.push(binary ? data : JSON.parse(data.toString()));
        if (!binary && JSON.parse(data.toString()).type === 'metadata') resolve();
      });
      socket!.once('error', reject);
    });
    await connected;
    const rejectedClient = new WebSocket(`${url.replace('https:', 'wss:')}/stream/${udid}?fps=30`, {
      ...tlsOptions(profile),
      headers: { Authorization: `Bearer ${profile.token}` },
    });
    const rejection = await new Promise<string>((resolve, reject) => {
      rejectedClient.once('message', (data) => resolve(JSON.parse(data.toString()).message));
      rejectedClient.once('error', reject);
    });
    assert.match(rejection, /another client/);
    rejectedClient.close();
    socket.send(JSON.stringify({ type: 'touch', phase: 'down', point: { x: 0.5, y: 0.25 } }));
    socket.send(JSON.stringify({ type: 'touch', phase: 'down', point: { x: 5, y: 0 } }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(inputs.length, 1);
    assert.deepEqual(inputs[0], { type: 'touch', phase: 'down', point: { x: 0.5, y: 0.25 } });
    assert.ok(events.some((e) => Buffer.isBuffer(e)));
    assert.ok(events.some((e) => typeof e === 'object' && e && 'type' in e && e.type === 'error'));
    socket.close();
    await new Promise((resolve) => socket!.once('close', resolve));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(released, true);
  } finally {
    socket?.terminate();
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});
