import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { AdaptiveVideo, qualitySchema } from '../src/host/adaptive';
import { defaultQuality, type RecordingStatus } from '../src/shared/media';
import { AudioCoordinator, AudioFramer } from '../src/host/audio';
import { RecordingStore } from '../src/host/recording';
import { HostMedia, MediaPeer } from '../src/host/media';
import { ClientMedia } from '../src/electron/media';
import { AudioPlayback } from '../src/renderer/media-playback';
import { SimulatorSession } from '../src/host/simulator';
import { spawn } from 'node:child_process';
import { childCompletion, terminateChild } from '../src/host/media-process';
import type { Profile } from '../src/shared/types';

const udid = '12345678-1234-4234-8234-123456789abc';
function atom(type: string, bytes: number) {
  const data = Buffer.alloc(bytes + 8);
  data.writeUInt32BE(data.length);
  data.write(type, 4);
  return data;
}
const mp4 = Buffer.concat([atom('ftyp', 16), atom('mdat', 64), atom('moov', 16)]);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function temporary(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-media-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: any[] = [];
  send(data: string | Buffer) {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
  }
  get socket() {
    return this as unknown as WebSocket;
  }
}

const negotiate = (client: ClientMedia) =>
  client.message(
    Buffer.from(
      JSON.stringify({
        type: 'media-capabilities',
        capabilities: { adaptive: true, recording: true, audio: true, audioScope: 'host' },
      }),
    ),
    false,
  );

test('automatic quality steps down under congestion, recovers slowly, honors caps', () => {
  let now = 0;
  const video = new AdaptiveVideo(60, () => now);
  video.configure({ ...defaultQuality(60), maxFps: 30, maxScale: 0.75, maxKbps: 1000 });
  for (let sample = 0; sample < 4; sample++) {
    for (let n = 0; n < 60; n++) {
      now += 34;
      video.allow(100000, 300000);
    }
    video.sample();
  }
  assert.deepEqual(video.settings, { fps: 8, scale: 0.4, quality: 0.4 });
  for (let sample = 0; sample < 4; sample++) {
    now += 2100;
    video.allow(100, 0);
    video.sample();
  }
  assert.equal(video.settings.scale, 0.55);
  assert.ok(video.settings.fps <= 30 && video.settings.scale <= 0.75);
});
test('manual settings stay fixed while token bucket bounds bytes and drops obsolete frames', () => {
  let now = 0,
    sent = 0;
  const video = new AdaptiveVideo(30, () => now);
  video.configure({
    ...defaultQuality(),
    mode: 'manual',
    maxKbps: 512,
    maxScale: 0.5,
    quality: 0.8,
  });
  for (let n = 0; n < 300; n++) {
    now += 1000 / 30;
    if (video.allow(10000, 0)) sent += 10000;
    video.sample();
  }
  assert.ok(sent <= 512 * 125 * 10 + 32000);
  assert.deepEqual(video.settings, { fps: 30, scale: 0.5, quality: 0.8 });
});
test('slow decoder drives adaptation and stale telemetry expires', () => {
  let now = 0;
  const video = new AdaptiveVideo(30, () => now);
  video.report({ decoded: 5, dropped: 20, decodeMs: 100, intervalMs: 1000 });
  now = 2100;
  video.allow(10, 0);
  const sample = video.sample()!;
  assert.equal(sample.decodedFps, 5);
  assert.equal(sample.decodeMs, 100);
  assert.equal(video.settings.scale, 0.85);
  now = 8000;
  assert.equal(video.sample()!.decodeMs, undefined);
  assert.equal(qualitySchema.safeParse({ ...defaultQuality(), maxScale: 3 }).success, false);
  assert.throws(() => video.report({ decoded: -1 }));
});
test('normal alternating source jitter does not halve the requested frame rate', () => {
  let now = 0,
    sent = 0;
  const video = new AdaptiveVideo(30, () => now);
  video.configure({ ...defaultQuality(), mode: 'manual', maxKbps: 100000 });
  for (let frame = 0; frame < 300; frame++) {
    now = Math.max(0, (frame * 1000) / 30 + (frame % 2 ? -3 : 3));
    if (video.allow(1000, 0)) sent++;
  }
  assert.ok(sent >= 295 && sent <= 300, `Expected near30FPS despite jitter, got ${sent / 10}`);
});
test('PCM framing survives every byte boundary and rejects hostile size/alignment', () => {
  const pcm = Buffer.alloc(384, 42),
    header = Buffer.alloc(4);
  header.writeUInt32LE(pcm.length);
  const data = Buffer.concat([header, pcm, header, pcm]);
  const framer = new AudioFramer();
  const output: Buffer[] = [];
  for (const byte of data) output.push(...framer.push(Buffer.from([byte])));
  assert.equal(output.length, 2);
  assert.deepEqual(output[0], pcm);
  assert.throws(() => new AudioFramer().push(Buffer.from([255, 255, 255, 255])), /Invalid PCM/);
  assert.throws(() => new AudioFramer().push(Buffer.from([3, 0, 0, 0])), /Invalid PCM/);
  assert.throws(() => new AudioFramer().push(Buffer.alloc(300000)), /buffer limit/);
});
test('audio requires host opt-in, excludes concurrent owners, and releases on failure/close', async () => {
  let closed = 0;
  const factory = async () => ({
    close: async () => {
      closed++;
    },
  });
  await assert.rejects(
    new AudioCoordinator(false, factory).start(
      {},
      () => {},
      () => {},
      new AbortController().signal,
    ),
    /Mac owner/,
  );
  const coordinator = new AudioCoordinator(true, factory),
    signal = new AbortController().signal;
  const one = await coordinator.start(
    {},
    () => {},
    () => {},
    signal,
  );
  await assert.rejects(
    coordinator.start(
      {},
      () => {},
      () => {},
      signal,
    ),
    /already shared/,
  );
  await Promise.all([one.close(), one.close()]);
  assert.equal(closed, 1);
  await (
    await coordinator.start(
      {},
      () => {},
      () => {},
      signal,
    )
  ).close();
  assert.equal(closed, 2);
  let fail = true;
  const failing = new AudioCoordinator(true, async () => {
    if (fail) throw new Error('permission');
    return factory();
  });
  await assert.rejects(
    failing.start(
      {},
      () => {},
      () => {},
      signal,
    ),
    /permission/,
  );
  fail = false;
  await (
    await failing.start(
      {},
      () => {},
      () => {},
      signal,
    )
  ).close();
});
test('recording start/stop/discard is idempotent, ticket protected, and removes files', async (t) => {
  const directory = await temporary(t);
  let stops = 0,
    closes = 0;
  const statuses: RecordingStatus[] = [];
  const store = new RecordingStore(directory, async (_udid, file) => ({
    stop: async () => {
      stops++;
      await writeFile(file, mp4);
    },
    abort: async () => {
      closes++;
    },
  }));
  await store.initialize();
  const recording = store.create(udid, (status) => statuses.push(status));
  await Promise.all([recording.start(), recording.start()]);
  const [download, second] = await Promise.all([recording.stop(), recording.stop()]);
  assert.deepEqual(download, second);
  assert.equal(stops, 1);
  assert.equal(store.download(download.id, 'x'.repeat(64)), undefined);
  assert.equal(store.download(download.id, undefined), undefined);
  assert.equal(store.download(download.id, 'é'.repeat(64)), undefined);
  assert.equal(store.download(download.id, download.ticket)?.bytes, mp4.length);
  assert.deepEqual(await readFile(recording.file), mp4);
  await Promise.all([recording.close(), recording.close()]);
  assert.equal(closes, 1);
  assert.equal(store.download(download.id, download.ticket), undefined);
  assert.deepEqual(await readdir(directory), []);
  assert.deepEqual(
    statuses.map((s) => s.phase),
    ['starting', 'recording', 'finalizing', 'ready', 'idle'],
  );
});
test('disconnect during capture startup aborts and removes temporary resources', async (t) => {
  const directory = await temporary(t);
  let aborted = false,
    ready!: () => void;
  const factoryReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const store = new RecordingStore(
    directory,
    async (_udid, _file, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('canceled'));
          },
          { once: true },
        );
        ready();
      }),
  );
  await store.initialize();
  const recording = store.create(udid, () => {});
  const started = recording.start();
  const failed = assert.rejects(started, /canceled/);
  await factoryReady;
  await recording.close();
  await failed;
  assert.equal(aborted, true);
  assert.deepEqual(await readdir(directory), []);
});
test('failed/empty finalization never exposes a download; discard still cleans', async (t) => {
  const directory = await temporary(t);
  for (const content of [Buffer.alloc(0), Buffer.alloc(64)]) {
    const store = new RecordingStore(directory, async (_udid, file) => ({
      stop: async () => {
        await writeFile(file, content);
      },
      abort: async () => {},
    }));
    await store.initialize();
    const recording = store.create(udid, () => {});
    await recording.start();
    await assert.rejects(recording.stop());
    assert.equal(store.download(recording.id, recording.ticket), undefined);
    await recording.close();
  }
  assert.deepEqual(await readdir(directory), []);
});
test('media peer serializes capture commands, rejects missing consent, and closes during audio startup', async (t) => {
  const directory = await temporary(t);
  let finish!: () => void,
    closed = 0;
  const coordinator = new AudioCoordinator(true, async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      close: async () => {
        closed++;
      },
    };
  });
  const host = new HostMedia(new RecordingStore(directory), coordinator);
  host.capabilities.audio = true;
  const socket = new FakeSocket(),
    peer = new MediaPeer(socket.socket, udid, 30, host, () => {});
  const send = (action: string, consent?: boolean) =>
    peer.handle({ type: 'media-control', id: randomUUID(), action, hostAudioConsent: consent });
  send('audio-start');
  await tick();
  assert.match(socket.sent.at(-1).error, /Confirm/);
  send('audio-start', true);
  await tick();
  send('audio-start', true);
  assert.match(socket.sent.at(-1).error, /still running/);
  const cleanup = peer.close();
  finish();
  await cleanup;
  await tick();
  assert.equal(closed, 1);
});
test('client IPC gate keeps only latest video and one audio packet; reports replacement drops', async () => {
  const socket = new FakeSocket(),
    sent: { channel: string; value: unknown }[] = [];
  const client = new ClientMedia(socket.socket, {} as Profile, (channel, value) =>
    sent.push({ channel, value }),
  );
  for (let n = 0; n < 1000; n++) client.video(Buffer.from([n % 256]));
  assert.equal(sent.length, 1);
  client.consumed();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].value, new Uint8Array([999 % 256]));
  const audio = Buffer.concat([Buffer.from('SRA1'), Buffer.alloc(3840)]);
  for (let n = 0; n < 100; n++) assert.equal(client.message(audio, true), true);
  assert.equal(sent.filter((s) => s.channel === 'audio-frame').length, 1);
  client.consumedAudio();
  client.message(audio, true);
  assert.equal(sent.filter((s) => s.channel === 'audio-frame').length, 2);
  negotiate(client);
  client.feedback({ decoded: 2, dropped: 0, decodeMs: 1, intervalMs: 1000 });
  assert.equal(socket.sent.at(-1).feedback.dropped, 998);
  await client.close();
});
test('client media RPC reports host errors, rejects pending on disconnect, and keeps legacy notices', async () => {
  const socket = new FakeSocket(),
    client = new ClientMedia(socket.socket, {} as Profile, () => {});
  negotiate(client);
  const command = client.command('recording-start');
  const id = socket.sent.at(-1).id;
  client.message(
    Buffer.from(JSON.stringify({ type: 'media-result', id, error: 'Xcode unavailable' })),
    false,
  );
  await assert.rejects(command, /Xcode unavailable/);
  assert.equal(client.message(Buffer.from('{"type":"metadata"}'), false), false);
  const pending = client.command('audio-start', true),
    failed = assert.rejects(pending, /disconnected/);
  await client.close();
  await failed;
});

test('video reconfiguration cancels obsolete RPCs, preserves native points, and suppresses stale failures', async () => {
  const streams: any[] = [],
    frames: Buffer[] = [],
    errors: Error[] = [];
  const session = new SimulatorSession();
  const internals = session as any;
  internals.client = {
    videoStream: () => {
      const stream = Object.assign(new EventEmitter(), {
        start: undefined as any,
        write(value: any) {
          this.start = value;
        },
        cancel() {
          this.emit('error', new Error('canceled'));
        },
      });
      streams.push(stream);
      return stream;
    },
    close: () => {},
  };
  internals.frame = (data: Buffer) => frames.push(data);
  internals.onVideoError = (error: Error) => errors.push(error);
  internals.pointSize = { short: 390, long: 844 };
  session.metadata = { width: 1170, height: 2532, widthPoints: 390, heightPoints: 844 };
  session.setVideoSettings({ fps: 15, scale: 0.5, quality: 0.6 });
  session.setVideoSettings({ fps: 10, scale: 0.4, quality: 0.5 });
  streams[0].emit('end');
  assert.equal(errors.length, 0);
  assert.deepEqual(streams[1].start.start, {
    format: 'MJPEG',
    fps: 10,
    compressionQuality: 0.5,
    scaleFactor: 0.4,
  });
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 0, 0, 0, 1, 1, 17, 0, 255, 217]);
  jpeg.writeUInt16BE(468, 7);
  jpeg.writeUInt16BE(1012, 9);
  streams[0].emit('data', { payload: { data: jpeg } });
  assert.equal(frames.length, 0);
  streams[1].emit('data', { payload: { data: jpeg } });
  assert.equal(frames.length, 1);
  assert.equal(session.metadata.widthPoints, 844);
  assert.equal(session.metadata.heightPoints, 390);
  await session.close();
  assert.equal(errors.length, 0);
});
test('audio playback bounds scheduled samples and gain/mute never touches simulator or host volume', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const created: any[] = [];
  class Context {
    state = 'running';
    currentTime = 0;
    destination = {};
    sources: any[] = [];
    gain = { gain: { value: 1 }, connect() {}, disconnect() {} };
    constructor() {
      created.push(this);
    }
    createGain() {
      return this.gain;
    }
    createBuffer(_channels: number, frames: number, rate: number) {
      return { duration: frames / rate, getChannelData: () => new Float32Array(frames) };
    }
    createBufferSource() {
      const source = {
        connect() {},
        disconnect() {},
        start() {},
        stop() {
          this.stopped = true;
        },
        stopped: false,
      };
      this.sources.push(source);
      return source;
    }
    async resume() {}
    async close() {
      this.state = 'closed';
    }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
  try {
    const playback = new AudioPlayback(),
      context = created[0];
    playback.volume(0.4, false);
    assert.equal(context.gain.gain.value, 0.4);
    playback.volume(0.8, true);
    assert.equal(context.gain.gain.value, 0);
    for (let n = 0; n < 1000; n++) playback.push(new Uint8Array(3840));
    assert.ok(context.sources.length <= 8);
    assert.ok(context.sources.length >= 1);
    playback.close();
    assert.equal(context.state, 'closed');
    assert.ok(context.sources.every((source: any) => source.stopped));
  } finally {
    if (original) Object.defineProperty(globalThis, 'AudioContext', original);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  }
});
test('owned capture process finalizes on pipe EOF; spawn failures are observed', async () => {
  const child = spawn(
    process.execPath,
    ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'],
    { stdio: ['pipe', 'ignore', 'ignore'] },
  );
  const done = childCompletion(child);
  await terminateChild(child, done, () => child.stdin.end());
  assert.equal(child.exitCode, 0);
  const missing = spawn('/sim-relay-test/does-not-exist');
  await assert.rejects(childCompletion(missing), /ENOENT/);
});
test('hung captures receive bounded SIGKILL escalation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: string[] = [];
  const child = {
    exitCode: null,
    signalCode: null,
    kill: (signal: string) => {
      signals.push(signal);
    },
  };
  const stopped = terminateChild(child as any, new Promise(() => {}), () =>
    signals.push('graceful'),
  );
  assert.deepEqual(signals, ['graceful']);
  t.mock.timers.tick(8000);
  await stopped;
  assert.deepEqual(signals, ['graceful', 'SIGKILL']);
});
test('recording can finish after the shorter audio shutdown deadline without being killed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: string[] = [];
  let finish!: () => void;
  const child = {
    exitCode: null,
    signalCode: null,
    kill: (signal: string) => {
      signals.push(signal);
    },
  };
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stopped = terminateChild(child as any, done, () => signals.push('graceful'), 35000);
  t.mock.timers.tick(12000);
  assert.deepEqual(signals, ['graceful']);
  finish();
  await stopped;
  assert.deepEqual(signals, ['graceful']);
});
test('disconnect releases a save waiting on a native dialog without awaiting user interaction', async () => {
  const socket = new FakeSocket(),
    client = new ClientMedia(socket.socket, {} as Profile, () => {});
  negotiate(client);
  const saving = client.save(() => new Promise(() => {}));
  const id = socket.sent.at(-1).id;
  client.message(
    Buffer.from(
      JSON.stringify({
        type: 'media-result',
        id,
        result: { id: randomUUID(), ticket: '0'.repeat(64), bytes: 64 },
      }),
    ),
    false,
  );
  await tick();
  await client.close();
  assert.equal(await saving, false);
});

test('legacy hosts receive no media messages until capabilities are negotiated', async () => {
  const socket = new FakeSocket();
  const client = new ClientMedia(socket.socket, {} as Profile, () => {});
  client.feedback({ decoded: 30, dropped: 0, decodeMs: 2, intervalMs: 1000 });
  assert.throws(() => client.quality(defaultQuality()), /does not support/);
  await assert.rejects(client.command('recording-start'), /not advertised/);
  assert.deepEqual(socket.sent, []);
  negotiate(client);
  client.feedback({ decoded: 30, dropped: 0, decodeMs: 2, intervalMs: 1000 });
  assert.equal(socket.sent.at(-1).type, 'video-feedback');
  await client.close();
});

test('window transfer replays quality limits without reconfiguring the capture', async () => {
  const socket = new FakeSocket();
  const notices: any[] = [];
  const client = new ClientMedia(
    socket.socket,
    {} as Profile,
    (channel, value) => {
      if (channel === 'media-notice') notices.push(value);
    },
    15,
  );
  client.reannounce();
  assert.equal(notices.at(-1).limits.maxFps, 15);
  negotiate(client);
  const limits = { ...defaultQuality(10), mode: 'manual' as const, maxScale: 0.5 };
  client.quality(limits);
  const writes = socket.sent.length;
  client.reparent();
  notices.length = 0;
  client.reannounce();
  assert.deepEqual(notices.find((notice) => notice.type === 'quality-state').limits, limits);
  assert.equal(socket.sent.length, writes);
  await client.close();
});
