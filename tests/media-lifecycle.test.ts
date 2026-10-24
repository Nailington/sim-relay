import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { startHost, type Backend } from '../src/host/server';
import { HostMedia } from '../src/host/media';
import { AudioCoordinator, type AudioFactory } from '../src/host/audio';
import { RecordingStore, type RecordingFactory } from '../src/host/recording';
import { clientAdminRequest } from '../src/host/client-admin';
import { tlsOptions, pairRemoteClient, probeHost, remoteRequest } from '../src/electron/remote';
import type { Profile } from '../src/shared/types';

const devices = [
  '12345678-1234-4234-8234-123456789abc',
  '12345678-1234-4234-8234-123456789abd',
  '12345678-1234-4234-8234-123456789abe',
];
const metadata = { width: 390, height: 844, widthPoints: 390, heightPoints: 844 };
function atom(type: string, bytes: number) {
  const data = Buffer.alloc(bytes + 8);
  data.writeUInt32BE(data.length);
  data.write(type, 4);
  return data;
}
const mp4 = Buffer.concat([atom('ftyp', 16), atom('mdat', 64), atom('moov', 16)]);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 400; n++) {
    if (await check()) return;
    await delay(5);
  }
  assert.fail('Timed out waiting for media lifecycle');
}
async function fixture(t: TestContext, factory: RecordingFactory, audio?: AudioFactory) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-media-lifecycle-'));
  const sockets: WebSocket[] = [];
  let closeHost: (() => Promise<void>) | undefined;
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await closeHost?.();
    await rm(directory, { recursive: true, force: true });
  });
  const recordings = new RecordingStore(path.join(directory, 'recordings'), factory);
  const media = new HostMedia(recordings, new AudioCoordinator(!!audio, audio));
  const sessionsClosed: string[] = [],
    inputs: string[] = [];
  const frames = new Map<string, (frame: Buffer) => void>();
  const backend: Backend = {
    inventory: async () => ({
      devices: devices.map((udid) => ({ udid, name: 'Fixture', runtime: '', state: 'Booted' })),
      runtimes: [],
      devicetypes: [],
    }),
    run: async () => '',
    session: async (udid, _fps, frame) => {
      frames.set(udid, frame);
      return {
        metadata,
        input: () => {
          inputs.push(udid);
        },
        close: async () => {
          sessionsClosed.push(udid);
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
    media,
    info: {
      name: 'Fixture host',
      platform: 'macOS',
      version: 'test',
      companion: true,
      xcode: true,
    },
  });
  closeHost = () => host.close();
  media.capabilities.audio = !!audio;
  const probe = await probeHost(host.status.url!);
  return {
    directory,
    host,
    recordings,
    sessionsClosed,
    inputs,
    frames,
    async pair(name: string) {
      const profile = await pairRemoteClient(
        {
          id: name,
          name,
          url: host.status.url!,
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
    async connect(profile: Profile, udid = devices[0]) {
      const ws = new WebSocket(`${profile.url.replace('https:', 'wss:')}/stream/${udid}`, {
        ...tlsOptions(profile),
        headers: { Authorization: `Bearer ${profile.token}` },
      });
      sockets.push(ws);
      const messages: any[] = [];
      const waiters = new Set<() => void>();
      ws.on('error', () => {});
      ws.on('message', (raw, binary) => {
        messages.push(binary ? Buffer.from(raw as Buffer) : JSON.parse(raw.toString()));
        for (const wake of waiters) wake();
      });
      const message = (predicate: (value: any) => boolean): Promise<any> => {
        const found = messages.find(predicate);
        if (found) return Promise.resolve(found);
        return new Promise((resolve, reject) => {
          const closed = () => {
            waiters.delete(wake);
            reject(new Error('Fixture socket closed before media response.'));
          };
          const wake = () => {
            const found = messages.find(predicate);
            if (found) {
              waiters.delete(wake);
              ws.off('close', closed);
              resolve(found);
            }
          };
          waiters.add(wake);
          ws.once('close', closed);
        });
      };
      await message((value) => value.type === 'metadata');
      return {
        ws,
        messages,
        message,
        async command(action: string, extras = {}) {
          const id = randomUUID();
          ws.send(JSON.stringify({ type: 'media-control', id, action, ...extras }));
          const result = await message((value) => value.type === 'media-result' && value.id === id);
          if (result.error) throw new Error(result.error);
          return result.result;
        },
      };
    },
  };
}

async function pausedDownload(
  t: TestContext,
  profile: Profile,
  recording: { id: string; ticket: string },
) {
  let bytes = 0;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = https.get(
      new URL(`/recordings/${recording.id}`, profile.url),
      {
        ...tlsOptions(profile),
        headers: {
          Authorization: `Bearer ${profile.token}`,
          'X-Recording-Ticket': recording.ticket,
        },
      },
      resolve,
    );
    request.on('error', reject);
    t.after(() => request.destroy());
  });
  assert.equal(response.statusCode, 200);
  response.on('error', () => {});
  const closed = new Promise<void>((resolve) => response.once('close', resolve));
  response.on('data', (chunk) => {
    bytes += chunk.length;
  });
  // Stop consumption while the host's real TLS/file pipeline is still streaming.
  response.pause();
  t.after(() => response.destroy());
  return { response, closed, bytes: () => bytes };
}

for (const transportFailure of [false, true]) {
  test(
    `revocation truncates backpressured TLS recordings and closes owned WSS/captures${transportFailure ? ' despite individual transport failures' : ''}`,
    { timeout: 20000 },
    async (t) => {
      const large = Buffer.concat([
        atom('ftyp', 16),
        atom('mdat', 32 * 1024 * 1024),
        atom('moov', 16),
      ]);
      let audioClosed = 0,
        captureClosed = 0;
      let audioFrame!: (pcm: Buffer) => void;
      const f = await fixture(
        t,
        async (_udid, file) => ({
          stop: async () => {
            await writeFile(file, large);
          },
          abort: async () => {
            captureClosed++;
          },
        }),
        async (frame) => {
          audioFrame = frame;
          return {
            close: async () => {
              audioClosed++;
            },
          };
        },
      );
      const a = await f.pair('Revoked downloader'),
        b = await f.pair('Other client');
      const owner = await f.connect(a.profile),
        sibling = await f.connect(a.profile, devices[1]);
      const other = await f.connect(b.profile, devices[2]);
      await owner.command('audio-start', { hostAudioConsent: true });
      audioFrame(Buffer.alloc(3840));
      await owner.message(Buffer.isBuffer);
      await owner.command('recording-start');
      const recording = await owner.command('recording-stop');
      await sibling.command('recording-start');
      await other.command('recording-start');
      const otherRecording = await other.command('recording-stop');
      const responses: ServerResponse[] = [];
      f.host.server.on('request', (req, res) => {
        if (req.url === `/recordings/${recording.id}`) responses.push(res);
      });
      const downloads = await Promise.all([
        pausedDownload(t, a.profile, recording),
        pausedDownload(t, a.profile, recording),
      ]);
      const unaffected = await pausedDownload(t, b.profile, otherRecording);
      // Confirm that the real file/TLS pipelines are blocked on these paused readers.
      await waitFor(
        () => responses.length === 2 && responses.every((res) => res.writableNeedDrain),
      );
      assert.ok(downloads.every(({ response }) => !response.complete));
      let responseFailures = 0,
        socketFailures = 0;
      if (transportFailure) {
        const destroy = responses[0].destroy;
        t.mock.method(responses[0], 'destroy', function (this: ServerResponse, error?: Error) {
          if (responseFailures++ === 0) throw new Error('fixture response failed');
          return destroy.call(this, error);
        });
        const send = WebSocket.prototype.send;
        t.mock.method(
          WebSocket.prototype,
          'send',
          function (this: WebSocket, ...args: Parameters<typeof send>) {
            if (
              typeof args[0] === 'string' &&
              args[0].includes('"code":"authorization_required"') &&
              socketFailures++ === 0
            )
              throw new Error('fixture websocket failed');
            return send.apply(this, args);
          },
        );
      }
      const closed = [once(owner.ws, 'close'), once(sibling.ws, 'close')];
      assert.deepEqual(await clientAdminRequest(f.directory, { action: 'revoke', id: a.id }), {
        revoked: a.id,
      });
      const codes = (await Promise.all(closed)).map(([code]) => code);
      assert.deepEqual(codes, transportFailure ? [1006, 4003] : [4003, 4003]);
      if (transportFailure) {
        assert.ok(responseFailures > 0);
        assert.equal(socketFailures, 2);
      }
      assert.equal(audioClosed, 1);
      assert.equal(captureClosed, 2);
      assert.deepEqual(f.sessionsClosed.sort(), devices.slice(0, 2).sort());
      for (const download of downloads) {
        download.response.resume();
        await download.closed;
        assert.equal(download.response.complete, false);
        assert.ok(download.bytes() > 0, 'download must have started before revocation');
        assert.ok(download.bytes() < recording.bytes, 'revoked download must be truncated');
      }
      assert.equal(f.recordings.download(recording.id, recording.ticket), undefined);
      assert.equal(other.ws.readyState, WebSocket.OPEN);
      other.ws.send(JSON.stringify({ type: 'button', button: 'HOME' }));
      f.frames.get(devices[2])!(Buffer.from('unaffected video'));
      await other.message(
        (value) => Buffer.isBuffer(value) && value.toString() === 'unaffected video',
      );
      await waitFor(() => f.inputs.includes(devices[2]));
      unaffected.response.resume();
      await unaffected.closed;
      assert.equal(unaffected.response.complete, true);
      assert.equal(unaffected.bytes(), otherRecording.bytes);
      await remoteRequest(b.profile, 'GET', '/devices');
      await assert.rejects(remoteRequest(a.profile, 'GET', '/devices'), /no longer authorized/);
      await other.command('recording-discard');
      await other.command('audio-start', { hostAudioConsent: true });
      await other.command('audio-stop');
      // Re-pairing creates a fresh credential; the revoked token/ticket never revive.
      await f.pair('Replacement client');
      const denied = await new Promise<number | undefined>((resolve, reject) => {
        https
          .get(
            new URL(`/recordings/${recording.id}`, a.profile.url),
            {
              ...tlsOptions(a.profile),
              headers: {
                Authorization: `Bearer ${a.profile.token}`,
                'X-Recording-Ticket': recording.ticket,
              },
            },
            (res) => {
              res.resume();
              resolve(res.statusCode);
            },
          )
          .on('error', reject);
      });
      assert.equal(denied, 401);
      const deniedSocket = new WebSocket(
        `${a.profile.url.replace('https:', 'wss:')}/stream/${devices[0]}`,
        {
          ...tlsOptions(a.profile),
          headers: { Authorization: `Bearer ${a.profile.token}` },
        },
      );
      t.after(() => deniedSocket.terminate());
      deniedSocket.on('error', () => {});
      const deniedUpgrade = await new Promise<number | undefined>((resolve, reject) => {
        deniedSocket.once('unexpected-response', (_request, res) => {
          res.resume();
          deniedSocket.terminate();
          resolve(res.statusCode);
        });
        deniedSocket.once('open', () => reject(new Error('Revoked credential opened WSS')));
      });
      assert.equal(deniedUpgrade, 401);
      assert.equal(audioClosed, 2);
      assert.equal(captureClosed, 3);
      assert.deepEqual(await readdir(f.recordings.directory), []);
      assert.ok(responses.every((res) => res.destroyed));
    },
  );
}

for (const lifecycle of ['expiry', 'encoder exit', 'encoder failure'] as const) {
  test(
    `WSS recording ${lifecycle} releases ownership before idle and permits the next start`,
    { timeout: 15000 },
    async (t) => {
      const finished = deferred();
      let captures = 0,
        aborted = 0;
      const f = await fixture(t, async (_udid, file) => {
        const first = ++captures === 1;
        await writeFile(file, mp4);
        return {
          finished: first ? finished.promise : undefined,
          stop: async () => {},
          abort: async () => {
            aborted++;
          },
        };
      });
      const { profile } = await f.pair('Lifecycle client');
      const peer = await f.connect(profile);
      await peer.command('recording-start');
      let download: { id: string; ticket: string } | undefined;
      if (lifecycle === 'expiry') {
        // Only virtualize the expiry timeout; real TLS/WSS and host intervals keep running.
        t.mock.timers.enable({ apis: ['setTimeout'] });
        try {
          download = await peer.command('recording-stop');
          assert.ok(f.recordings.download(download!.id, download!.ticket));
          t.mock.timers.tick(10 * 60 * 1000);
        } finally {
          t.mock.timers.reset();
        }
      } else if (lifecycle === 'encoder exit') finished.resolve();
      else finished.reject(new Error('fixture encoder failed'));
      await peer.message((value) => value.type === 'recording' && value.recording.phase === 'idle');
      assert.equal(aborted, 1);
      assert.deepEqual(await readdir(f.recordings.directory), []);
      if (download) assert.equal(f.recordings.download(download.id, download.ticket), undefined);
      await peer.command('recording-start');
      assert.equal(captures, 2);
      const next = await peer.command('recording-stop');
      assert.ok(f.recordings.download(next.id, next.ticket));
      // An old completion after expiry cannot clear or close the replacement recording.
      finished.resolve();
      await peer.command('recording-discard');
      assert.equal(aborted, 2);
      assert.deepEqual(await readdir(f.recordings.directory), []);
      await f.host.close();
      assert.equal(f.sessionsClosed.length, 1);
    },
  );
}

test(
  'WSS discard during autonomous encoder cleanup waits for ownership and cannot clear the next recording',
  { timeout: 15000 },
  async (t) => {
    const finished = deferred(),
      abortStarted = deferred(),
      releaseAbort = deferred();
    t.after(() => releaseAbort.resolve());
    let captures = 0,
      aborted = 0;
    const f = await fixture(t, async (_udid, file) => {
      const first = ++captures === 1;
      await writeFile(file, mp4);
      return {
        finished: first ? finished.promise : undefined,
        stop: async () => {},
        abort: async () => {
          aborted++;
          if (first) {
            abortStarted.resolve();
            await releaseAbort.promise;
          }
        },
      };
    });
    const { profile } = await f.pair('Discard race');
    const peer = await f.connect(profile);
    await peer.command('recording-start');
    finished.resolve();
    await abortStarted.promise;
    await assert.rejects(peer.command('recording-start'), /Save or discard/);
    const discard = peer.command('recording-discard');
    releaseAbort.resolve();
    await discard;
    await peer.command('recording-start');
    const next = await peer.command('recording-stop');
    assert.equal(captures, 2);
    assert.equal(aborted, 1);
    assert.ok(f.recordings.download(next.id, next.ticket));
    await peer.command('recording-discard');
    assert.equal(aborted, 2);
    assert.deepEqual(await readdir(f.recordings.directory), []);
  },
);

test(
  'WSS recording startup failure and disconnect during the next startup release all owned resources',
  { timeout: 15000 },
  async (t) => {
    const starting = deferred(),
      finishStartup = deferred();
    let captures = 0,
      aborted = 0;
    t.after(() => finishStartup.resolve());
    const f = await fixture(t, async (_udid, file) => {
      if (++captures === 1) throw new Error('fixture startup failed');
      starting.resolve();
      // A late-returning factory must still be aborted after its socket disappears.
      await finishStartup.promise;
      await writeFile(file, mp4);
      return {
        stop: async () => {},
        abort: async () => {
          aborted++;
        },
      };
    });
    const { profile } = await f.pair('Startup race');
    const peer = await f.connect(profile);
    await assert.rejects(peer.command('recording-start'), /fixture startup failed/);
    assert.deepEqual(await readdir(f.recordings.directory), []);
    const pending = assert.rejects(peer.command('recording-start'), /socket closed/);
    await starting.promise;
    const closed = once(peer.ws, 'close');
    peer.ws.close();
    await closed;
    await pending;
    finishStartup.resolve();
    await waitFor(() => aborted === 1 && f.sessionsClosed.length === 1);
    assert.deepEqual(await readdir(f.recordings.directory), []);
    assert.equal(captures, 2);
  },
);
