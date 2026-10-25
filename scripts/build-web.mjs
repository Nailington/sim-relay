import { build } from 'esbuild';
import path from 'node:path';
import { cp, mkdir, rm } from 'node:fs/promises';

export async function buildWeb() {
  await mkdir('dist-web', { recursive: true });
  await build({
    entryPoints: ['src/web/cli.ts'],
    outfile: 'dist-web/web.cjs',
    platform: 'node',
    format: 'cjs',
    bundle: true,
    define: { SIM_RELAY_WEB_BUNDLED: 'true' },
  });
  await rm('dist-web/frontend', { recursive: true, force: true });
  await cp('dist', 'dist-web/frontend', { recursive: true });
}

if (path.basename(process.argv[1] ?? '') === 'build-web.mjs') await buildWeb();
