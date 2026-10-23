import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import https from 'node:https';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { startHost, type Backend } from '../src/host/server';
import { HostMedia } from '../src/host/media';
import { AudioCoordinator } from '../src/host/audio';
import { RecordingStore } from '../src/host/recording';
import { downloadRecording } from '../src/electron/media';
import { tlsOptions } from '../src/electron/remote';
import type { Profile } from '../src/shared/types';

const udid = '12345678-1234-4234-8234-123456789abc';
const info = {
  name: 'test host',
  platform: 'macOS',
  version: 'test',
  companion: true,
  xcode: true,
};
const metadata = { width: 390, height: 844, widthPoints: 390, heightPoints: 844 };
function atom(type: string, bytes: number) {
  const data = Buffer.alloc(bytes + 8);
  data.writeUInt32BE(data.length);
  data.write(type, 4);
  return data;
}
const mp4 = Buffer.concat([atom('ftyp', 16), atom('mdat', 2 * 1024 * 1024), atom('moov', 16)]);
test(
  'authenticated WSS owns recording/audio, ticket-gated HTTPS saves stream and clean on disconnect',
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'relay-media-transport-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let audioFrame: ((pcm: Buffer) => void) | undefined,
      audioClosed = 0,
      recordingClosed = 0,
      inputCount = 0,
      sessionClosed = 0;
    const recordings = new RecordingStore(
      path.join(directory, 'recordings'),
      async (_udid, file) => ({
        stop: async () => {
          await writeFile(file, mp4);
        },
        abort: async () => {
          recordingClosed++;
        },
      }),
    );
    const media = new HostMedia(
      recordings,
      new AudioCoordinator(true, async (frame) => {
        audioFrame = frame;
        return {
          close: async () => {
            audioClosed++;
          },
        };
      }),
    );
    const backend: Backend = {
      inventory: async () => ({ devices: [], runtimes: [], devicetypes: [] }),
      run: async () => '',
      session: async () => ({
        metadata,
        input: () => {
          inputCount++;
        },
        close: async () => {
          sessionClosed++;
        },
      }),
    };
    const host = await startHost({
      directory,
      port: 0,
      bind: '127.0.0.1',
      advertise: false,
      backend,
      info,
      media,
    });
    t.after(() => host.close());
    media.capabilities.audio = true;
    const profile: Profile = {
      id: 'test',
      name: 'test',
      url: host.status.url!,
      token: host.status.token!,
      certificate: await readFile(path.join(directory, 'host.pem'), 'utf8'),
      fingerprint: host.status.fingerprint,
      source: 'saved',
    };
    const request = (pathname: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; bytes: number }>((resolve, reject) => {
        const req = https.get(
          new URL(pathname, profile.url),
          { ...tlsOptions(profile), headers },
          (res) => {
            let bytes = 0;
            res.on('data', (chunk) => {
              bytes += chunk.length;
            });
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode!, bytes }));
          },
        );
        req.on('error', reject);
      });
    assert.equal((await request(`/recordings/${randomUUID()}`)).status, 401);
    assert.equal(
      (
        await request('/devices', {
          Authorization: `Bearer ${profile.token}`,
          Origin: 'https://evil.example',
        })
      ).status,
      403,
    );
    const denied = new WebSocket(`${profile.url.replace('https:', 'wss:')}/stream/${udid}`, {
      ...tlsOptions(profile),
    });
    await new Promise<void>((resolve, reject) => {
      denied.on('unexpected-response', (_req, res) => {
        assert.equal(res.statusCode, 401);
        res.destroy();
        denied.terminate();
        resolve();
      });
      denied.on('error', () => {});
      setTimeout(() => reject(new Error('Unauthorized upgrade was not rejected')), 2000).unref();
    });
    const ws = new WebSocket(`${profile.url.replace('https:', 'wss:')}/stream/${udid}`, {
      ...tlsOptions(profile),
      headers: { Authorization: `Bearer ${profile.token}` },
    });
    t.after(() => ws.terminate());
    const messages: any[] = [];
    ws.on('message', (data, binary) => {
      messages.push(binary ? Buffer.from(data as Buffer) : JSON.parse(data.toString()));
    });
    await once(ws, 'open');
    const waitFor = async (predicate: (value: any) => boolean) => {
      for (let n = 0; n < 400; n++) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.fail(`No matching message: ${JSON.stringify(messages)}`);
    };
    const command = async (action: string, extras = {}) => {
      const id = randomUUID();
      ws.send(JSON.stringify({ type: 'media-control', id, action, ...extras }));
      const result = await waitFor((value) => value.type === 'media-result' && value.id === id);
      if (result.error) throw new Error(result.error);
      return result.result;
    };
    await waitFor((value) => value.type === 'metadata');
    await assert.rejects(command('audio-start'), /Confirm/);
    await command('audio-start', { hostAudioConsent: true });
    audioFrame?.(Buffer.alloc(3840, 12));
    const audio = await waitFor((value) => Buffer.isBuffer(value));
    assert.equal(audio.subarray(0, 4).toString(), 'SRA1');
    assert.equal(audio.length, 3844);
    ws.send(JSON.stringify({ type: 'button', button: 'HOME' }));
    await command('recording-start');
    const recording = await command('recording-stop');
    const auth = { Authorization: `Bearer ${profile.token}` };
    assert.equal((await request(`/recordings/${recording.id}`, auth)).status, 404);
    assert.equal(
      (
        await request(`/recordings/${recording.id}`, {
          ...auth,
          'X-Recording-Ticket': '0'.repeat(64),
        })
      ).status,
      404,
    );
    assert.equal(
      (await request(`/recordings/${recording.id}`, { 'X-Recording-Ticket': recording.ticket }))
        .status,
      401,
    );
    const target = path.join(directory, 'client.mp4');
    let progress = 0;
    await downloadRecording(profile, recording, target, new AbortController().signal, (bytes) => {
      progress = bytes;
    });
    assert.deepEqual(await readFile(target), mp4);
    assert.equal(progress, mp4.length);
    // An interrupted transfer never replaces a previously saved file or leaves partial output.
    const abort = new AbortController();
    await assert.rejects(
      downloadRecording(profile, recording, target, abort.signal, () => abort.abort()),
    );
    assert.deepEqual(await readFile(target), mp4);
    assert.equal(
      (await readdir(directory)).some((file) => file.includes('.partial-')),
      false,
    );
    // Fingerprint mismatch is rejected before any recording request is made.
    await assert.rejects(
      downloadRecording(
        { ...profile, fingerprint: 'changed' },
        recording,
        target,
        new AbortController().signal,
        () => {},
      ),
      /certificate changed/,
    );
    ws.close();
    await once(ws, 'close');
    for (let n = 0; n < 200 && !recordingClosed; n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(recordingClosed, 1);
    assert.equal(audioClosed, 1);
    assert.equal(inputCount, 1);
    await host.close();
    assert.equal(sessionClosed, 1);
    assert.deepEqual(await readdir(recordings.directory), []);
    assert.equal(recordings.download(recording.id, recording.ticket), undefined);
  },
);
