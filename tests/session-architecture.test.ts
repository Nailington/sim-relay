import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  RelaySession,
  RETRY_DELAYS,
  SessionFailure,
  SessionRouter,
  type SessionTarget,
} from '../src/electron/session';
import type { StreamNotice } from '../src/shared/types';
const target: SessionTarget = { hostId: 'mac-a', udid: 'sim-a', fps: 60 };
const meta = {
  type: 'metadata',
  metadata: { width: 1200, height: 2600, widthPoints: 400, heightPoints: 866 },
};
class Socket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  terminated = false;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.terminate();
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
    this.emit('close', 1006);
  }
  notice(value: object) {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }
}
function fixture() {
  const notices: StreamNotice[] = [],
    frames: Uint8Array[] = [],
    sockets: Socket[] = [],
    opens: SessionTarget[] = [];
  const timers: { callback: () => void; delay: number; canceled: boolean }[] = [];
  let failure: Error | undefined;
  const session = new RelaySession({
    open: async (t) => {
      opens.push({ ...t });
      if (failure) throw failure;
      const s = new Socket();
      sockets.push(s);
      return s;
    },
    frame: (f) => frames.push(f),
    notice: (n) => notices.push(n),
    schedule: (callback, delay) => {
      const t = { callback, delay, canceled: false };
      timers.push(t);
      return t;
    },
    cancel: (t) => {
      (t as (typeof timers)[number]).canceled = true;
    },
  });
  return {
    session,
    notices,
    frames,
    sockets,
    timers,
    opens,
    fail: (e?: Error) => {
      failure = e;
    },
  };
}
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
};
test('outage releases held input, restores original selection and never replays stale events', async () => {
  const f = fixture();
  await f.session.connect(target);
  f.sockets[0].notice(meta);
  f.session.input({ type: 'touch', phase: 'down', point: { x: 0.2, y: 0.4 } });
  f.session.input({ type: 'key', phase: 'down', code: 225 });
  f.sockets[0].emit('error', new Error('ECONNRESET'));
  assert.deepEqual(f.sockets[0].sent.slice(-2), [
    { type: 'touch', phase: 'up', point: { x: 0.2, y: 0.4 } },
    { type: 'key', phase: 'up', code: 225 },
  ]);
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].delay, 1000);
  f.session.input({ type: 'button', button: 'HOME' });
  f.timers[0].callback();
  await flush();
  f.sockets[1].notice(meta);
  assert.deepEqual(f.opens, [target, target]);
  assert.deepEqual(f.sockets[1].sent, []);
  f.sockets[0].notice(meta);
  f.sockets[0].emit('message', Buffer.from([1]), true);
  assert.equal(f.frames.length, 0);
  f.sockets[1].emit('message', Buffer.from([2]), true);
  assert.equal(f.frames[0][0], 2);
});
test('backoff exhausts exactly once and explicit disconnect cancels retries', async () => {
  const f = fixture();
  f.fail(new Error('offline'));
  await f.session.connect(target);
  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    assert.equal(f.timers[i].delay, RETRY_DELAYS[i]);
    f.timers[i].callback();
    await flush();
  }
  assert.equal(f.timers.length, RETRY_DELAYS.length);
  assert.equal(f.notices.at(-1)?.state, 'failed');
  f.fail();
  await f.session.retry();
  f.sockets[0].notice(meta);
  assert.equal(f.notices.at(-2)?.state, 'live');
  f.sockets[0].terminate();
  f.session.disconnect();
  const n = f.opens.length;
  f.timers.at(-1)!.callback();
  await flush();
  assert.equal(f.opens.length, n);
  assert.equal(f.notices.at(-1)?.state, 'off');
});
test('credentials, certificate changes, protocol mismatch and stopped devices are terminal', async () => {
  for (const error of [
    new SessionFailure('HTTP 401', true),
    new Error('Unexpected server response: 403'),
    Object.assign(new Error('TLS failure'), { code: 'CERT_HAS_EXPIRED' }),
    new Error('unsupported connection protocol'),
    new Error('This simulator is not booted'),
  ]) {
    const f = fixture();
    f.fail(error);
    await f.session.connect(target);
    assert.equal(f.notices.at(-1)?.state, 'failed');
    assert.equal(f.timers.length, 0);
  }
  for (const revoked of ['notice', 'close']) {
    const f = fixture();
    await f.session.connect(target);
    f.sockets[0].notice(meta);
    if (revoked === 'notice')
      f.sockets[0].notice({
        type: 'error',
        code: 'authorization_required',
        message: 'Authorization revoked',
      });
    else f.sockets[0].emit('close', 4003);
    assert.equal(f.timers.length, 0);
    assert.equal(f.notices.at(-1)?.state, 'failed');
  }
});
test('independent owners preserve hosts, frames, input, errors and transfers', async () => {
  const a = fixture(),
    b = fixture();
  const router = new SessionRouter<number, RelaySession>();
  router.set(1, a.session);
  router.set(2, b.session);
  await a.session.connect(target);
  await b.session.connect({ ...target, hostId: 'mac-b' });
  a.sockets[0].notice(meta);
  b.sockets[0].notice(meta);
  router.get(1)!.input({ type: 'button', button: 'HOME' });
  router.get(2)!.input({ type: 'button', button: 'LOCK' });
  assert.deepEqual(a.sockets[0].sent, [{ type: 'button', button: 'HOME' }]);
  assert.deepEqual(b.sockets[0].sent, [{ type: 'button', button: 'LOCK' }]);
  assert.equal(router.ownerOf('mac-b', 'sim-a'), 2);
  assert.equal(router.ownerOf('mac-a', 'sim-a'), 1);
  router.move(1, 3);
  assert.equal(router.get(1), undefined);
  assert.equal(router.get(3), a.session);
  assert.throws(() => router.move(3, 2), /already owns/);
  a.session.disconnect();
  assert.equal(b.sockets[0].terminated, false);
  b.session.input({ type: 'button', button: 'HOME' });
  assert.equal(b.sockets[0].sent.length, 2);
});
test('an in-flight connection is discarded after cancel or a newer selection', async () => {
  let resolve!: (socket: Socket) => void;
  const f = fixture();
  const old = new Socket();
  const session = new RelaySession({
    open: () =>
      new Promise((r) => {
        resolve = r;
      }),
    frame: () => assert.fail('stale frame'),
    notice: (n) => f.notices.push(n),
  });
  const pending = session.connect(target);
  session.disconnect();
  resolve(old);
  await pending;
  assert.equal(old.terminated, true);
  assert.equal(f.notices.at(-1)?.state, 'off');
});
test('returning a live display reannounces metadata without replacing its transport', async () => {
  const f = fixture();
  await f.session.connect(target);
  f.sockets[0].notice(meta);
  const n = f.notices.length;
  await f.session.connect(target);
  assert.equal(f.opens.length, 1);
  assert.equal(f.notices.length, n + 2);
  assert.equal(f.notices.at(-1)?.type, 'metadata');
});
test('disconnected and terminal sessions retain retry target without reserving the simulator', async () => {
  const a = fixture(),
    b = fixture();
  const router = new SessionRouter<number, RelaySession>();
  router.set(1, a.session);
  router.set(2, b.session);
  await a.session.connect(target);
  assert.equal(router.ownerOf(target.hostId, target.udid), 1);
  a.session.disconnect();
  assert.deepEqual(a.session.target, target);
  assert.equal(a.session.active, false);
  assert.equal(router.ownerOf(target.hostId, target.udid), undefined);
  await b.session.connect(target);
  b.sockets[0].notice(meta);
  assert.equal(router.ownerOf(target.hostId, target.udid), 2);
  b.sockets[0].notice({ type: 'error', terminal: true, message: 'Credential revoked' });
  assert.equal(b.session.active, false);
  assert.equal(router.ownerOf(target.hostId, target.udid), undefined);
});
test('moving a connecting or retrying target does not restart its transport or retry budget', async () => {
  const f = fixture();
  await f.session.connect(target);
  await f.session.connect(target);
  assert.equal(f.opens.length, 1);
  assert.equal(f.sockets[0].terminated, false);
  f.sockets[0].emit('error', new Error('offline'));
  await f.session.connect(target);
  assert.equal(f.opens.length, 1);
  assert.equal(f.timers.length, 1);
  assert.equal(f.notices.at(-1)?.state, 'retrying');
  await f.session.retry();
  assert.equal(f.opens.length, 2);
  assert.equal(f.timers[0].canceled, true);
});
