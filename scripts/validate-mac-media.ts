/** Opt-in real Mac test. Run only with a dedicated "Sim Relay Media Validation ..." device. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { startHost } from '../src/host/server';
import { exec, MacSimulator } from '../src/host/simulator';
import { jpegDimensions } from '../src/host/protocol';
import { tlsOptions } from '../src/electron/remote';
import { downloadRecording } from '../src/electron/media';
import type { Profile } from '../src/shared/types';
import { defaultQuality } from '../src/shared/media';

const udid = process.env.SIM_RELAY_VALIDATION_UDID;
const root = process.env.SIM_RELAY_VALIDATION_DIR;
if (process.platform !== 'darwin' || !udid || !root?.startsWith('/tmp/sim-relay-media-'))
  throw new Error(
    'Use a Mac, a dedicated validation UDID, and a private /tmp/sim-relay-media-* directory.',
  );
const backend = new MacSimulator();
const device = (await backend.inventory()).devices.find((device) => device.udid === udid);
assert.ok(
  device?.name.startsWith('Sim Relay Media Validation '),
  'Refusing to capture an unrelated simulator.',
);
await mkdir(path.join(root, 'artifacts'), { recursive: true, mode: 0o700 });
const host = await startHost({
  directory: path.join(root, 'validation-state'),
  bind: '127.0.0.1',
  port: 49319,
  advertise: false,
});
const transferConfiguration = path.join(root, 'private-transfer.json');
const transferReceipt = path.join(root, 'private-transfer-receipt.json');
const profile: Profile = {
  id: 'native-validation',
  name: 'native-validation',
  url: host.status.url!,
  token: host.status.token!,
  certificate: await readFile(path.join(root, 'validation-state/host.pem'), 'utf8'),
  fingerprint: host.status.fingerprint,
  source: 'saved',
};
const results: Record<string, unknown> = {
  platform: `${process.platform}/${process.arch}`,
  udid,
  port: 49319,
  source:
    process.env.SIM_RELAY_VALIDATION_SOURCE ??
    'Dedicated simulator; verify fixture launch separately',
};
let socket: WebSocket | undefined;
const pending = new Map<
  string,
  { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
>();
let phase = 'opening',
  frameCount = 0,
  byteCount = 0,
  latest: Buffer | undefined,
  metadata: unknown;
let audioPackets = 0,
  audioPeak = 0,
  audioSquare = 0,
  audioSamples = 0,
  audioToneEnergy = 0;
const metrics: unknown[] = [];
const log = (value: object) => console.log(JSON.stringify(value));
async function command(action: string, extra = {}): Promise<any> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        pending.delete(id);
        reject(new Error(`Native ${action} timed out.`));
      },
      action.startsWith('recording-') ? 65000 : 35000,
    );
    pending.set(id, { resolve, reject, timer });
    socket!.send(JSON.stringify({ type: 'media-control', id, action, ...extra }));
  });
}
async function sample(name: string, limits: object, milliseconds: number, interact = false) {
  phase = name;
  frameCount = byteCount = 0;
  latest = undefined;
  socket!.send(JSON.stringify({ type: 'quality', limits }));
  const start = performance.now();
  if (interact) {
    await delay(1000);
    socket!.send(
      JSON.stringify({
        type: 'swipe',
        start: { x: 0.85, y: 0.6 },
        end: { x: 0.15, y: 0.6 },
        duration: 0.3,
      }),
    );
    try {
      await exec('xcrun', ['simctl', 'status_bar', udid!, 'override', '--time', '09:41'], {
        timeout: 15000,
      });
    } catch (error) {
      results.interactionWarning = (error as Error).message;
    }
    await delay(1500);
    socket!.send(
      JSON.stringify({
        type: 'swipe',
        start: { x: 0.15, y: 0.6 },
        end: { x: 0.85, y: 0.6 },
        duration: 0.3,
      }),
    );
    try {
      await exec('xcrun', ['simctl', 'status_bar', udid!, 'override', '--time', '09:42'], {
        timeout: 15000,
      });
    } catch (error) {
      results.interactionWarning = (error as Error).message;
    }
    await delay(Math.max(0, milliseconds - (performance.now() - start)));
  } else await delay(milliseconds);
  const elapsed = performance.now() - start;
  assert.ok(frameCount > 0, `No native frames for ${name}.`);
  const dimensions = latest ? jpegDimensions(latest) : undefined;
  results[name] = {
    frames: frameCount,
    seconds: elapsed / 1000,
    receivedFps: (frameCount * 1000) / elapsed,
    payloadKbps: (byteCount * 8) / elapsed,
    dimensions,
    metadata,
  };
  if (latest) await writeFile(path.join(root!, 'artifacts', `${name}.jpg`), latest);
  log({ phase, result: results[name] });
}
try {
  socket = new WebSocket(`${profile.url.replace('https:', 'wss:')}/stream/${udid}`, {
    ...tlsOptions(profile),
    headers: { Authorization: `Bearer ${profile.token}` },
    handshakeTimeout: 15000,
  });
  const errors: string[] = [];
  socket.on('message', (data, binary) => {
    if (binary) {
      const bytes = Buffer.from(data as Buffer);
      if (bytes.subarray(0, 4).toString() === 'SRA1') {
        audioPackets++;
        let real = 0,
          imaginary = 0;
        for (let offset = 4, frame = 0; offset + 3 < bytes.length; offset += 4, frame++) {
          const value = bytes.readInt16LE(offset) / 32768;
          audioPeak = Math.max(audioPeak, Math.abs(value));
          audioSquare += value * value;
          audioSamples++;
          real += value * Math.cos((2 * Math.PI * 880 * frame) / 48000);
          imaginary -= value * Math.sin((2 * Math.PI * 880 * frame) / 48000);
        }
        audioToneEnergy += real * real + imaginary * imaginary;
      } else {
        frameCount++;
        byteCount += bytes.length;
        latest = bytes;
      }
      return;
    }
    const notice = JSON.parse(data.toString());
    if (notice.type === 'metadata') metadata = notice.metadata;
    if (notice.type === 'error') errors.push(notice.message);
    if (notice.type === 'metrics') metrics.push({ phase, metrics: notice.metrics });
    if (notice.type === 'media-ping')
      socket?.send(JSON.stringify({ type: 'media-pong', sentAt: notice.sentAt }));
    if (notice.type === 'media-result') {
      const item = pending.get(notice.id);
      if (item) {
        clearTimeout(item.timer);
        pending.delete(notice.id);
        notice.error ? item.reject(new Error(notice.error)) : item.resolve(notice.result);
      }
    }
  });
  await once(socket, 'open');
  for (let n = 0; n < 300 && !metadata && !errors.length; n++) await delay(100);
  assert.deepEqual(errors, []);
  assert.ok(metadata, 'Native session did not become ready.');
  log({ phase: 'native-session-ready', metadata });
  await command('recording-start');
  await sample(
    'full-resolution',
    { ...defaultQuality(), mode: 'manual', maxKbps: 30000 },
    5000,
    process.env.SIM_RELAY_VALIDATE_INTERACTION === '1',
  );
  socket.send(JSON.stringify({ type: 'rotate', orientation: 'LANDSCAPE_LEFT' }));
  await sample(
    'half-resolution',
    { ...defaultQuality(15), mode: 'manual', maxScale: 0.5, quality: 0.5 },
    5000,
    process.env.SIM_RELAY_VALIDATE_INTERACTION === '1',
  );
  const recording = await command('recording-stop');
  const target = path.join(root, 'artifacts/native-screen.mp4');
  let transferred = 0;
  await downloadRecording(profile, recording, target, new AbortController().signal, (bytes) => {
    transferred = bytes;
  });
  const probe = await exec(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_name,width,height,nb_frames:format=duration,size',
      '-of',
      'json',
      target,
    ],
    { timeout: 15000 },
  );
  await exec('ffmpeg', ['-v', 'error', '-i', target, '-f', 'null', '-'], {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  results.recording = {
    downloadedBytes: transferred,
    ffprobe: JSON.parse(probe.stdout),
    decodedWithoutErrors: true,
  };
  if (process.env.SIM_RELAY_VALIDATION_REMOTE_TRANSFER === '1') {
    // Ephemeral credentials stay in private files, never logs or committed evidence.
    await rm(transferReceipt, { force: true });
    await writeFile(transferConfiguration, JSON.stringify({ profile, recording }), { mode: 0o600 });
    log({ phase: 'remote-transfer-ready', bytes: recording.bytes });
    let receipt: unknown;
    for (let attempt = 0; attempt < 180; attempt++) {
      try {
        receipt = JSON.parse(await readFile(transferReceipt, 'utf8'));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await delay(500);
    }
    assert.ok(receipt, 'External client did not acknowledge a recording transfer within90s.');
    results.remoteClientTransfer = receipt;
    await rm(transferConfiguration, { force: true });
  }
  await command('recording-discard');
  log({ phase: 'native-recording-decoded', result: results.recording });
  await sample('constrained-budget', { ...defaultQuality(), maxKbps: 1000 }, 14000);
  if (process.env.SIM_RELAY_VALIDATE_AUDIO === '1') {
    try {
      await command('audio-start', { hostAudioConsent: true });
      await delay(5000);
      await command('audio-stop');
      results.audio = {
        status: 'captured',
        packets: audioPackets,
        sampleFrames: audioSamples,
        peak: audioPeak,
        rms: Math.sqrt(audioSquare / Math.max(1, audioSamples)),
        tone880Energy: audioToneEnergy,
        note: 'Aggregate statistics only. No PCM was persisted and no remote listening test is claimed.',
      };
    } catch (error) {
      results.audio = {
        status: 'blocked',
        message: (error as Error).message,
        packets: audioPackets,
      };
    }
  } else {
    results.audio = {
      status: 'skipped',
      reason:
        'Audio requires separate explicit validation opt-in; permission approval may still be pending.',
    };
  }
  log({ phase: 'native-audio-result', result: results.audio });
  await command('recording-start');
  await delay(2000);
  socket.terminate();
  await once(socket, 'close');
  await host.close();
  const remaining = await readdir(path.join(root, 'validation-state/recordings'));
  assert.deepEqual(remaining, []);
  results.disconnectCleanup = { recordingDirectoriesRemaining: remaining.length };
  results.metrics = metrics;
  assert.deepEqual(errors, []);
  results.errors = errors;
  await writeFile(
    path.join(root, 'artifacts/native-result.json'),
    JSON.stringify(results, null, 2),
  );
  log({ phase: 'native-validation-complete', results });
} finally {
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(new Error('Validation stopped.'));
  }
  socket?.terminate();
  await host.close();
  await rm(transferConfiguration, { force: true });
  await rm(transferReceipt, { force: true });
}
