import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';
const icon = new Resvg(await readFile('assets/app-icon.svg', 'utf8'), {
  fitTo: { mode: 'width', value: 1024 },
});
await writeFile('assets/app-icon.png', icon.render().asPng());
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
await build({
  entryPoints: ['src/host/cli.ts'],
  outfile: 'dist-host/host.cjs',
  platform: 'node',
  format: 'cjs',
  bundle: true,
  // The macOS CLI lives outside app.asar and must work without Node/npm installed.
});
await mkdir('dist-host', { recursive: true });
await copyFile('src/host/idb.proto', 'dist-host/idb.proto');
