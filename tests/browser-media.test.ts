import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BrowserMedia } from '../src/renderer/browser-media';
import { browserRecording } from '../src/renderer/browser-recording';
import { mediaControlSchema } from '../src/web/media-control';
import { RecordingDownloads } from '../src/web/recording-download';
import type { ServerResponse } from 'node:http';
import type { Profile } from '../src/shared/types';

test('browser decode delivery keeps one in progress and only the latest replacement, with cleanup across sockets', async () => {
  const writes: any[] = [];
  const media = new BrowserMedia((value) => writes.push(value));
  media.notify({
    type: 'media-capabilities',
    capabilities: { adaptive: true, recording: true, audio: true, audioScope: 'host' },
  });
  const decoded: number[] = [];
  let complete!: () => void;
  media.frames.add(async (frame) => {
    decoded.push(frame[0]);
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
  });
  media.video(new Uint8Array([1]));
  await new Promise((resolve) => setImmediate(resolve));
  media.video(new Uint8Array([2]));
  media.video(new Uint8Array([3]));
  media.video(new Uint8Array([4]));
  assert.deepEqual(decoded, [1]);
  complete();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(decoded, [1, 4]);
  media.feedback({ decoded: 1, dropped: 0, decodeMs: 2, intervalMs: 1000 });
  assert.equal(writes[0].feedback.dropped, 2);
  media.video(new Uint8Array([5]));
  media.close();
  complete();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(decoded, [1, 4], 'old pending frame cannot leak into a replacement socket');
});

test('browser media routes PCM separately, replays latest state to mounts, and rejects pending commands on close', async () => {
  const writes: any[] = [];
  const media = new BrowserMedia((value) => writes.push(value));
  media.notify({
    type: 'media-capabilities',
    capabilities: { adaptive: true, recording: true, audio: true, audioScope: 'host' },
  });
  const audio: number[] = [];
  media.audio.add((value) => audio.push(value.length));
  assert.equal(media.message(new Uint8Array([83, 82, 65, 49, 0, 1, 0, 1])), true);
  assert.equal(media.message(new Uint8Array([83, 82, 65, 49, 0])), true);
  assert.deepEqual(audio, [4]);
  assert.equal(media.message(new Uint8Array([255, 216])), false);
  const command = media.command('audio-start', true);
  assert.equal(writes[0].hostAudioConsent, true);
  media.message(JSON.stringify({ type: 'media-result', id: writes[0].id }));
  await command;
  media.message(JSON.stringify({ type: 'audio', active: true }));
  const replay: any[] = [];
  const off = media.subscribe((value) => replay.push(value));
  await Promise.resolve();
  assert.equal(replay.find((n) => n.type === 'audio').active, true);
  const pending = media.command('recording-stop');
  const rejected = assert.rejects(pending, /disconnected/);
  media.close();
  await rejected;
  assert.equal(replay.at(-1).recording.phase, 'idle');
  off();
});

test('legacy browser streams never receive unnegotiated feedback, quality or media controls', async () => {
  const writes: unknown[] = [];
  const media = new BrowserMedia((value) => writes.push(value));
  media.feedback({ decoded: 30, dropped: 0, decodeMs: 1, intervalMs: 1000 });
  assert.throws(
    () => media.quality({ mode: 'auto', maxFps: 30, maxScale: 1, quality: 0.7, maxKbps: 1000 }),
    /does not support/,
  );
  await assert.rejects(media.command('recording-start'), /not enabled/);
  assert.deepEqual(writes, []);
});

test('browser quality cache follows each connection default and replays manual limits without extra writes', async () => {
  const writes: unknown[] = [];
  const media = new BrowserMedia((value) => writes.push(value));
  media.open(15);
  media.notify({
    type: 'media-capabilities',
    capabilities: { adaptive: true, recording: true, audio: false, audioScope: 'host' },
  });
  const limits = {
    mode: 'manual',
    maxFps: 60,
    maxScale: 0.5,
    quality: 0.6,
    maxKbps: 1000,
  } as const;
  media.quality(limits);
  const replay: any[] = [];
  const off = media.subscribe((value) => replay.push(value));
  await Promise.resolve();
  assert.deepEqual(replay.find((n) => n.type === 'quality-state').limits, limits);
  assert.equal(writes.length, 1, 'late subscribers do not issue another quality command');
  off();
  media.close();
  media.open(30);
  const next: any[] = [];
  const offNext = media.subscribe((value) => next.push(value));
  await Promise.resolve();
  assert.equal(next.find((n) => n.type === 'quality-state').limits.maxFps, 30);
  assert.equal(next.find((n) => n.type === 'quality-state').limits.mode, 'auto');
  offNext();
  media.close();
});

test('relay media controls have a strict finite schema and cannot tunnel arbitrary fields', () => {
  assert.ok(
    mediaControlSchema.safeParse({
      type: 'media-control',
      id: randomUUID(),
      action: 'audio-start',
      hostAudioConsent: true,
    }).success,
  );
  assert.ok(mediaControlSchema.safeParse({ type: 'media-pong', sentAt: 1234 }).success);
  for (const value of [
    { type: 'media-control', id: randomUUID(), action: 'shell' },
    { type: 'media-control', id: randomUUID(), action: 'recording-start', profile: 'extra' },
    { type: 'media-pong', sentAt: Infinity },
    {
      type: 'video-feedback',
      feedback: { decoded: 1, dropped: 0, decodeMs: NaN, intervalMs: 1000 },
    },
    {
      type: 'quality',
      limits: { mode: 'auto', maxFps: 60, maxScale: 1, quality: 0.7, maxKbps: 1000, extra: true },
    },
  ])
    assert.equal(mediaControlSchema.safeParse(value).success, false);
});

test('download capabilities expire, are cookie scoped, and logout revokes outstanding tickets', async () => {
  let now = 1000;
  const downloads = new RecordingDownloads(() => now);
  const profile = {} as Profile;
  const recording = { id: randomUUID(), ticket: 'a'.repeat(64), bytes: 100 };
  const first = downloads.issue('alice-cookie', profile, recording).path.split('/').at(-1)!;
  assert.equal(await downloads.serve(first, 'bob-cookie', {} as ServerResponse), false);
  now += 60_001;
  assert.equal(await downloads.serve(first, 'alice-cookie', {} as ServerResponse), false);
  const second = downloads.issue('alice-cookie', profile, recording).path.split('/').at(-1)!;
  downloads.revoke('alice-cookie');
  assert.equal(await downloads.serve(second, 'alice-cookie', {} as ServerResponse), false);
  const third = downloads
    .issue('bob-cookie', profile, recording, now + 1)
    .path.split('/')
    .at(-1)!;
  now += 2;
  assert.equal(await downloads.serve(third, 'bob-cookie', {} as ServerResponse), false);
});

test('browser save releases a pending picker on disconnect and keeps a failed streaming save retryable', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalFetch = globalThis.fetch;
  const recording = { id: randomUUID(), ticket: 'b'.repeat(64), bytes: 32 };
  const notices: any[] = [];
  let commands = 0;
  const media = new BrowserMedia((value: any) => {
    commands++;
    queueMicrotask(() =>
      media.message(JSON.stringify({ type: 'media-result', id: value.id, result: recording })),
    );
  });
  const advertise = () =>
    media.notify({
      type: 'media-capabilities',
      capabilities: { adaptive: true, recording: true, audio: false, audioScope: 'host' },
    });
  const off = media.subscribe((value) => notices.push(value));
  const save = browserRecording(
    media,
    () => ({}) as Profile,
    async () => ({ path: '/api/download/' + 'a'.repeat(43) }),
  );
  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { showSaveFilePicker: () => new Promise(() => {}) },
    });
    const pending = save();
    media.close();
    assert.equal(await pending, false);
    assert.equal(commands, 0, 'canceled picker never requests the recording or creates a file');
    advertise();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        showSaveFilePicker: async () => ({
          createWritable: async () =>
            new WritableStream({
              write() {
                throw new Error('disk full fixture');
              },
            }),
        }),
      },
    });
    globalThis.fetch = async () => new Response(new Uint8Array(32));
    await assert.rejects(save(), /disk full fixture/);
    assert.equal(notices.at(-1).recording.phase, 'ready');
    assert.match(notices.at(-1).recording.message, /retry Save/);
  } finally {
    off();
    media.close();
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
