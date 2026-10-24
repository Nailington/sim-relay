import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { HostMedia } from '../src/host/media';
import { AudioCoordinator } from '../src/host/audio';
import { RecordingStore } from '../src/host/recording';
import { startHost, type Backend } from '../src/host/server';
import { remoteRequest, probeHost } from '../src/electron/remote';
import type { InputEvent, Inventory } from '../src/shared/types';
const directory = await mkdtemp(path.join(tmpdir(), 'sim-relay-native-'));
const ids = [
  'A1234567-1234-4123-8123-123456789ABC',
  'B1234567-1234-4123-8123-123456789ABC',
  'C1234567-1234-4123-8123-123456789ABC',
];
const events = new Map(ids.map((id) => [id, [] as InputEvent[]]));
const inventory: Inventory = {
  runtimes: [],
  devicetypes: [],
  devices: ids.map((udid, i) => ({
    udid,
    name: `Native ${String.fromCharCode(65 + i)}`,
    runtime: 'iOS fake',
    state: 'Booted',
  })),
};
let starts = 0;
const captures = new Map(ids.map((id) => [id, { starts: 0, stops: 0, closes: 0 }]));
const qualities = new Map(ids.map((id) => [id, [] as number[]]));
let audioStarts = 0,
  audioCloses = 0;
const atom = (type: string) => {
  const data = Buffer.alloc(16);
  data.writeUInt32BE(16);
  data.write(type, 4);
  return data;
};
const mp4 = Buffer.concat(['ftyp', 'mdat', 'moov'].map(atom));
const media = new HostMedia(
  new RecordingStore(path.join(directory, 'recordings'), async (id, file) => {
    const trace = captures.get(id)!;
    trace.starts++;
    await writeFile(file, mp4);
    return {
      stop: async () => {
        trace.stops++;
      },
      abort: async () => {
        trace.closes++;
      },
    };
  }),
  new AudioCoordinator(true, async () => {
    audioStarts++;
    return {
      close: async () => {
        audioCloses++;
      },
    };
  }),
  true,
);
const backend: Backend = {
  inventory: async () => inventory,
  run: async () => '',
  session: async (udid) => {
    starts++;
    return {
      metadata: { width: 400, height: 800, widthPoints: 400, heightPoints: 800 },
      input: (e) => events.get(udid)!.push(e),
      setVideoSettings: (settings) => {
        qualities.get(udid)!.push(settings.fps);
      },
      close: async () => {},
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
    name: 'Native Test Mac',
    platform: 'macOS',
    version: 'test',
    protocolVersion: 1,
    xcode: true,
    companion: true,
  },
});
media.capabilities.audio = true;
const pairingCode = host.status.token!;
assert.equal(host.status.info?.clientAuthorization, true);
try {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      electron as unknown as string,
      [
        '--no-sandbox',
        '--ozone-platform=headless',
        '--disable-gpu',
        path.resolve('tests/electron-session-smoke.cjs'),
      ],
      {
        env: {
          ...process.env,
          SIM_RELAY_DEV: '0',
          SIM_RELAY_SMOKE_USER_DATA: path.join(directory, 'client'),
          SIM_RELAY_SMOKE_URL: host.status.url,
          SIM_RELAY_SMOKE_PAIRING_CODE: pairingCode,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Native session smoke exceeded 60 seconds'));
    }, 60000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      code === 0 && output.includes('NATIVE_SESSION_SMOKE_OK')
        ? resolve()
        : reject(new Error(`Electron smoke exited ${code}`));
    });
  });
  assert.notEqual(
    host.status.token,
    pairingCode,
    'desktop pairRemoteClient must consume the single-use pairing code',
  );
  const probe = await probeHost(host.status.url!);
  await assert.rejects(
    remoteRequest(
      {
        id: 'bootstrap',
        name: 'bootstrap',
        url: probe.url,
        source: 'saved',
        certificate: probe.certificate,
        fingerprint: probe.fingerprint,
        token: pairingCode,
      },
      'GET',
      '/devices',
    ),
    /authorized/,
  );
  assert.equal(starts, 4, 'moving/returning live sessions must not create extra sockets');
  assert.ok(events.get(ids[0])!.some((e) => e.type === 'button' && e.button === 'HOME'));
  assert.ok(events.get(ids[0])!.some((e) => e.type === 'button' && e.button === 'VOLUME_UP'));
  assert.ok(!events.get(ids[0])!.some((e) => e.type === 'button' && e.button === 'LOCK'));
  assert.ok(events.get(ids[1])!.some((e) => e.type === 'button' && e.button === 'LOCK'));
  assert.equal(captures.get(ids[0])!.starts, 1, 'pop-out/return retain the original recording');
  assert.equal(captures.get(ids[0])!.stops, 1);
  assert.equal(captures.get(ids[1])!.starts, 1, 'B controls are scoped to B');
  for (let i = 0; i < ids.length; i++) {
    assert.ok(
      events.get(ids[i])!.some((event) => event.type === 'key' && event.code === 40 + i),
      `concurrent returns retain independently controllable ${ids[i][0]}`,
    );
  }
  assert.equal(audioStarts, 1);
  assert.equal(audioCloses, 1);
  assert.ok(qualities.get(ids[0])!.includes(10));
  assert.ok(qualities.get(ids[1])!.includes(5));
  console.log('Native fake-host input and media ownership assertions passed');
} finally {
  await host.close();
  assert.deepEqual(await readdir(media.recordings.directory), []);
  await rm(directory, { recursive: true, force: true });
}
