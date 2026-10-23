import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startHost, type Backend } from '../src/host/server';
import { tlsOptions, probeHost, pairRemoteClient, remoteRequest } from '../src/electron/remote';
import type { InputEvent, Inventory, StreamMeta, StreamNotice } from '../src/shared/types';
const ids = ['A1234567-1234-4123-8123-123456789ABC', 'B1234567-1234-4123-8123-123456789ABC'];
const wait = async (check: () => boolean) => {
  const until = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > until) assert.fail('condition did not become true');
    await new Promise((r) => setTimeout(r, 5));
  }
};
test('real pinned HTTPS/WSS isolates two devices, rejects conflicts, forwards rotation and respects shutdown', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sim-relay-session-test-'));
  const state = new Map<
    string,
    { events: InputEvent[]; metadata: StreamMeta; frame: (data: Buffer) => void; closed: boolean }
  >();
  const inventory: Inventory = {
    runtimes: [],
    devicetypes: [],
    devices: ids.map((udid) => ({ udid, name: udid[0], state: 'Booted', runtime: 'iOS fake' })),
  };
  let starts = 0;
  let closeGate: Promise<void> | undefined;
  const backend: Backend = {
    inventory: async () => inventory,
    run: async () => {
      assert.fail('a stream must never boot or run a device command');
    },
    session: async (udid, _fps, frame) => {
      starts++;
      const entry = {
        events: [] as InputEvent[],
        metadata: { width: 400, height: 800, widthPoints: 400, heightPoints: 800 } as StreamMeta,
        frame,
        closed: false,
      };
      state.set(udid, entry);
      return {
        metadata: entry.metadata,
        input: (event) => entry.events.push(event),
        close: async () => {
          entry.closed = true;
          await closeGate;
        },
      };
    },
  };
  const host = await startHost({
    directory,
    port: 0,
    bind: '127.0.0.1',
    advertise: false,
    backend,
    info: {
      name: 'Test Mac',
      platform: 'macOS',
      version: 'test',
      protocolVersion: 1,
      xcode: true,
      companion: true,
    },
  });
  const probe = await probeHost(host.status.url!);
  const pairingCode = host.status.token!;
  const profile = await pairRemoteClient(
    {
      id: 'test',
      name: 'Test Mac',
      source: 'saved',
      url: probe.url,
      token: pairingCode,
      certificate: probe.certificate,
      fingerprint: probe.fingerprint,
    },
    probe,
    'Session protocol test',
  );
  assert.notEqual(profile.token, pairingCode);
  await assert.rejects(
    remoteRequest({ ...profile, token: pairingCode }, 'GET', '/devices'),
    /authorized/,
  );
  const sockets: WebSocket[] = [];
  const open = (udid: string) => {
    const socket = new WebSocket(
      host.status.url!.replace('https:', 'wss:') + `/stream/${udid}?fps=30`,
      { ...tlsOptions(profile), headers: { Authorization: `Bearer ${profile.token}` } },
    );
    const notices: StreamNotice[] = [],
      frames: Buffer[] = [];
    socket.on('message', (data, binary) =>
      binary ? frames.push(data as Buffer) : notices.push(JSON.parse(data.toString())),
    );
    sockets.push(socket);
    return { socket, notices, frames };
  };
  try {
    const a = open(ids[0]),
      b = open(ids[1]);
    await wait(
      () =>
        a.notices.some((n) => n.type === 'metadata') &&
        b.notices.some((n) => n.type === 'metadata'),
    );
    a.socket.send(JSON.stringify({ type: 'button', button: 'HOME' }));
    b.socket.send(JSON.stringify({ type: 'button', button: 'LOCK' }));
    await wait(
      () => state.get(ids[0])!.events.length === 1 && state.get(ids[1])!.events.length === 1,
    );
    assert.deepEqual(state.get(ids[0])!.events, [{ type: 'button', button: 'HOME' }]);
    assert.deepEqual(state.get(ids[1])!.events, [{ type: 'button', button: 'LOCK' }]);
    const conflict = open(ids[0]);
    await wait(() => conflict.notices.length > 0);
    assert.equal(conflict.notices[0].terminal, true);
    assert.match(conflict.notices[0].message!, /another client/);
    assert.equal(starts, 2);
    state.get(ids[0])!.metadata.rotation = 90;
    state.get(ids[0])!.frame(Buffer.from([1]));
    state.get(ids[1])!.frame(Buffer.from([2]));
    await wait(() => a.frames.length === 1 && b.frames.length === 1);
    assert.equal(a.notices.at(-1)?.metadata?.rotation, 90);
    assert.deepEqual(a.frames[0], Buffer.from([1]));
    assert.deepEqual(b.frames[0], Buffer.from([2]));
    let finishClose!: () => void;
    closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    a.socket.terminate();
    await wait(() => state.get(ids[0])!.closed);
    const resumed = open(ids[0]);
    await wait(() => resumed.socket.readyState === WebSocket.OPEN);
    assert.equal(resumed.notices.length, 0, 'replacement waits for old companion cleanup');
    closeGate = undefined;
    finishClose();
    await wait(() => resumed.notices.some((n) => n.type === 'metadata'));
    assert.equal(starts, 3);
    resumed.socket.terminate();
    await wait(() => state.get(ids[0])!.closed);
    assert.equal(b.socket.readyState, WebSocket.OPEN);
    assert.equal(state.get(ids[1])!.closed, false);
    inventory.devices[0].state = 'Shutdown';
    const stopped = open(ids[0]);
    await wait(() => stopped.notices.length > 0);
    assert.equal(stopped.notices[0].terminal, true);
    assert.match(stopped.notices[0].message!, /not booted/);
    assert.equal(starts, 3);
  } finally {
    for (const socket of sockets) socket.terminate();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
