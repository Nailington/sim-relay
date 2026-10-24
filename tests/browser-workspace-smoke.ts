import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { startHost, type Backend } from '../src/host/server';
import { startWeb } from '../src/web/server';
import { HostMedia } from '../src/host/media';
import { RecordingStore } from '../src/host/recording';
import { clientAdminRequest } from '../src/host/client-admin';
import type { InputEvent } from '../src/shared/types';

const directory = await mkdtemp(path.join(tmpdir(), 'relay-browser-workspaces-'));
const identitySmoke = process.argv[2] === 'identity';
const ids = ['A1234567-1234-4123-8123-123456789ABC', 'B1234567-1234-4123-8123-123456789ABC'];
const events: { udid: string; event: InputEvent }[] = [];
const closed: string[] = [];
const atom = (name: string, size: number) => {
  const data = Buffer.alloc(size + 8);
  data.writeUInt32BE(data.length);
  data.write(name, 4);
  return data;
};
const mp4 = Buffer.concat([atom('ftyp', 16), atom('mdat', 2 * 1024 * 1024), atom('moov', 16)]);
const media = new HostMedia(
  new RecordingStore(path.join(directory, 'recordings'), async (_udid, file) => ({
    stop: async () => {
      await writeFile(file, mp4);
    },
    abort: async () => {},
  })),
);
const backend: Backend = {
  inventory: async () => ({
    runtimes: [],
    devicetypes: [],
    devices: ids.map((udid, i) => ({
      udid,
      name: `Browser Phone ${i ? 'B' : 'A'}`,
      state: 'Booted',
      runtime: 'iOS fake',
    })),
  }),
  run: async () => '',
  session: async (udid) => ({
    metadata: { width: 400, height: 800, widthPoints: 400, heightPoints: 800 },
    input: (event) => {
      events.push({ udid, event });
    },
    close: async () => {
      closed.push(udid);
    },
  }),
};
const host = await startHost({
  directory,
  port: 0,
  bind: '127.0.0.1',
  advertise: false,
  backend,
  media,
  info: {
    name: 'Browser Test Mac',
    platform: 'macOS',
    version: '0.1.5',
    protocolVersion: 1,
    xcode: true,
    companion: true,
  },
});
const web = await startWeb({
  port: 0,
  users: { alice: 'alice-test-password-long', bob: 'bob-test-password-long' },
  allowedHosts: [host.status.url!],
  directory: path.resolve('dist'),
});
try {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      electron as unknown as string,
      [
        '--no-sandbox',
        '--ozone-platform=headless',
        '--disable-gpu',
        path.resolve(
          identitySmoke
            ? 'tests/electron-browser-identity.cjs'
            : 'tests/electron-browser-workspaces.cjs',
        ),
      ],
      {
        env: {
          ...process.env,
          SIM_RELAY_SMOKE_USER_DATA: path.join(directory, 'browser'),
          SIM_RELAY_SMOKE_WEB: web.origin,
          SIM_RELAY_SMOKE_MAC: host.status.url,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Browser workspaces smoke exceeded 60 seconds'));
    }, 60_000);
    child.on('message', async (value: { id: number; op: string }) => {
      try {
        let result: unknown;
        if (value.op === 'pair-code') result = host.status.token;
        if (value.op === 'events') result = { events, closed };
        if (value.op === 'revoke-alice') {
          const clients = (await clientAdminRequest(directory, { action: 'list' })) as {
            id: string;
            name: string;
          }[];
          result = await clientAdminRequest(directory, {
            action: 'revoke',
            id: clients.find((c) => c.name === 'alice browser')!.id,
          });
        }
        child.send({ id: value.id, result });
      } catch {
        child.send({ id: value.id, error: 'Test control action failed' });
      }
    });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0);
        assert.match(
          output,
          identitySmoke ? /BROWSER_IDENTITY_SMOKE_OK/ : /BROWSER_WORKSPACES_SMOKE_OK/,
        );
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  if (!identitySmoke) {
    assert.ok(
      events.some(
        (e) => e.udid === ids[0] && e.event.type === 'button' && e.event.button === 'HOME',
      ),
    );
    assert.ok(
      events.some(
        (e) => e.udid === ids[1] && e.event.type === 'button' && e.event.button === 'LOCK',
      ),
    );
    assert.ok(
      !events.some(
        (e) => e.udid === ids[1] && e.event.type === 'button' && e.event.button === 'HOME',
      ),
    );
  }
} finally {
  await web.close();
  await host.close();
  await rm(directory, { recursive: true, force: true });
}
