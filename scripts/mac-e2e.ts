/** Real Mac smoke test. Uses an isolated simulator and deletes it when finished. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { probeHost, remoteRequest, tlsOptions } from '../src/electron/remote';
import type { Inventory, Profile } from '../src/shared/types';
const url = process.env.SIM_RELAY_TEST_URL ?? 'https://127.0.0.1:49310';
const tokenFile = process.env.SIM_RELAY_TEST_TOKEN_FILE;
if (!tokenFile) throw new Error('Set SIM_RELAY_TEST_TOKEN_FILE to a private token file.');
const probe = await probeHost(url);
const p: Profile = {
  id: 'e2e',
  name: probe.info.name,
  url,
  token: (await readFile(tokenFile, 'utf8')).trim(),
  certificate: probe.certificate,
  fingerprint: probe.fingerprint,
  source: 'saved',
};
const request = async <T>(method: string, path: string, body?: unknown): Promise<T> =>
  JSON.parse((await remoteRequest(p, method, path, body)).toString());
const inventory = await request<Inventory>('GET', '/devices');
console.log(
  'Host reachable; certificate pinned; installed iOS runtimes:',
  inventory.runtimes.map((r) => r.name).join(', '),
);
let udid = '',
  socket: WebSocket | undefined;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const runtime = inventory.runtimes[0];
  assert.ok(runtime, 'An iOS runtime must be installed.');
  const type =
    inventory.devicetypes.find((t) => t.name === 'iPhone 17 Pro') ??
    inventory.devicetypes.find((t) => t.productFamily === 'iPhone');
  assert.ok(type);
  udid =
    process.env.SIM_RELAY_TEST_DEVICE ??
    (
      await request<{ udid: string }>('POST', '/devices', {
        name: 'Sim Relay E2E',
        deviceType: type.identifier,
        runtime: runtime.identifier,
      })
    ).udid;
  console.log('Created isolated simulator:', udid);
  await writeFile('/tmp/sim-relay-e2e-udid', udid);
  await request('POST', `/devices/${udid}/boot`);
  console.log('Simulator boot completed.');
  socket = new WebSocket(`${url.replace('https:', 'wss:')}/stream/${udid}?fps=30`, {
    ...tlsOptions(p),
    headers: { Authorization: `Bearer ${p.token}` },
  });
  let frames = 0,
    bytes = 0,
    first: Buffer | undefined,
    latest: Buffer | undefined;
  const errors: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No frame within 60 seconds.')), 60000);
    socket!.on('message', (raw, binary) => {
      if (binary) {
        frames++;
        bytes += raw.byteLength;
        latest = Buffer.from(raw as Buffer);
        first ??= latest;
        if (frames === 10) {
          clearTimeout(timer);
          resolve();
        }
      } else {
        const notice = JSON.parse(raw.toString());
        if (notice.type === 'error') {
          errors.push(notice.message);
          clearTimeout(timer);
          reject(new Error(notice.message));
        }
        if (notice.type === 'metadata') console.log('Display metadata:', notice.metadata);
      }
    });
    socket!.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  await writeFile('/tmp/sim-relay-live.jpg', first!);
  assert.equal(first![0], 255);
  assert.equal(first![1], 216);
  console.log(`Received ${frames} JPEG frames (${bytes} bytes).`);
  const before = Buffer.from(latest!);
  socket.send(JSON.stringify({ type: 'button', button: 'LOCK' }));
  await sleep(1500);
  const locked = Buffer.from(latest!);
  await writeFile('/tmp/sim-relay-locked.jpg', locked);
  assert.notEqual(
    createHash('sha256').update(before).digest('hex'),
    createHash('sha256').update(locked).digest('hex'),
  );
  console.log('Lock button visibly changed the streamed simulator screen.');
  socket.send(JSON.stringify({ type: 'button', button: 'HOME' }));
  await sleep(500);
  socket.send(
    JSON.stringify({
      type: 'swipe',
      start: { x: 0.5, y: 0.98 },
      end: { x: 0.5, y: 0.3 },
      duration: 0.4,
    }),
  );
  await sleep(1200);
  const home = await remoteRequest(p, 'GET', `/devices/${udid}/screenshot`);
  await writeFile('/tmp/sim-relay-home.png', home);
  assert.equal(home.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  console.log('Screenshot endpoint returned a valid PNG.');
  for (const event of [
    { type: 'touch', phase: 'down', point: { x: 0.5, y: 0.6 } },
    { type: 'touch', phase: 'move', point: { x: 0.5, y: 0.3 } },
    { type: 'touch', phase: 'up', point: { x: 0.5, y: 0.3 } },
    { type: 'pinch', center: { x: 0.5, y: 0.5 }, scale: 1.2 },
    { type: 'shake' },
    { type: 'key', phase: 'down', code: 40 },
    { type: 'key', phase: 'up', code: 40 },
  ]) {
    socket.send(JSON.stringify(event));
    await sleep(150);
  }
  await request('POST', `/devices/${udid}/appearance`, { appearance: 'dark' });
  await request('POST', `/devices/${udid}/location`, { latitude: 37.3349, longitude: -122.009 });
  await request('POST', `/devices/${udid}/url`, { url: 'https://example.com' });
  await sleep(1000);
  assert.deepEqual(errors, []);
  console.log(
    'Touch, drag, pinch, shake, keyboard, appearance, location, and URL actions accepted without host errors.',
  );
  console.log(`Total stream: ${frames} frames, ${Math.round(bytes / 1024)} KiB. PASS`);
} finally {
  if (socket) {
    socket.close();
    await sleep(500);
  }
  if (udid && !process.env.SIM_RELAY_TEST_DEVICE && process.env.SIM_RELAY_TEST_KEEP !== '1') {
    await request('POST', `/devices/${udid}/shutdown`).catch(() => {});
    await request('POST', '/command', { args: ['delete', udid], confirmed: true });
    console.log('Removed isolated test simulator.');
  }
}
