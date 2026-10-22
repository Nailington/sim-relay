import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
await build({
  entryPoints: ['src/electron/main.ts'],
  outfile: 'dist-electron/main.cjs',
  platform: 'node',
  format: 'cjs',
  bundle: true,
  packages: 'external',
});
await build({
  entryPoints: ['src/electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
  platform: 'node',
  format: 'cjs',
  bundle: true,
  external: ['electron'],
});
// Bind our own server before opening Electron. Never load an unrelated service on this port.
const server = await createServer({ server: { host: '127.0.0.1', port: 5173, strictPort: true } });
await server.listen();
server.printUrls();
const electron = spawn(require('electron'), ['.'], {
  stdio: 'inherit',
  env: { ...process.env, SIM_RELAY_DEV: '1' },
});
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  electron.kill();
  await server.close();
  process.exit(code);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
electron.once('error', (error) => {
  console.error(error.message);
  void stop(1);
});
electron.once('exit', (code) => void stop(code ?? 0));
