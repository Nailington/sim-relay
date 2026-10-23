import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electron from 'electron';

const directory = await mkdtemp(path.join(tmpdir(), 'sim-relay-browser-renderer-'));
try {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      electron as unknown as string,
      [
        '--no-sandbox',
        '--ozone-platform=headless',
        '--disable-gpu',
        path.resolve('tests/electron-browser-renderer.cjs'),
      ],
      {
        env: { ...process.env, SIM_RELAY_SMOKE_USER_DATA: directory },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Browser renderer smoke exceeded 60 seconds'));
    }, 60_000);
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
        assert.match(output, /BROWSER_RENDERER_SMOKE_OK/);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
