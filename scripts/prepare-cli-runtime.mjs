// The CLI has its own runtime: launching the desktop executable can be blocked by
// macOS policy for a particular .app location before Electron enters Node mode.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const cliNodeVersion = '24.22.3';
const archives = {
  arm64: 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd',
  x64: '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7',
};
export async function prepareCliRuntime(arch = process.arch) {
  if (process.platform !== 'darwin') return;
  const checksum = archives[arch];
  if (!checksum) throw new Error(`Unsupported macOS CLI architecture: ${arch}`);
  const name = `node-v${cliNodeVersion}-darwin-${arch}`;
  const temporary = await mkdtemp(path.join(tmpdir(), 'sim-relay-node-'));
  const staged = path.join('dist-runtime', `.node-${randomUUID()}`);
  try {
    const response = await fetch(`https://nodejs.org/dist/v${cliNodeVersion}/${name}.tar.gz`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Node runtime download failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(archive).digest('hex') !== checksum)
      throw new Error('Node runtime download does not match its pinned SHA-256 checksum.');
    const file = path.join(temporary, 'node.tar.gz');
    await writeFile(file, archive);
    await promisify(execFile)('/usr/bin/tar', [
      '-xzf',
      file,
      '-C',
      temporary,
      `${name}/bin/node`,
      `${name}/LICENSE`,
    ]);
    const executable = path.join(temporary, name, 'bin/node');
    const { stdout } = await promisify(execFile)(
      executable,
      ['-p', 'process.version + "/" + process.arch'],
      {
        timeout: 15_000,
      },
    );
    if (stdout.trim() !== `v${cliNodeVersion}/${arch}`)
      throw new Error('Unexpected CLI runtime version or architecture.');
    await mkdir('dist-runtime', { recursive: true });
    // Never overwrite an executable inode: macOS may retain its old code-signing
    // state. A fresh inode also keeps repeated local packaging runs reliable.
    await copyFile(executable, staged);
    await chmod(staged, 0o755);
    await rename(staged, 'dist-runtime/node');
    await copyFile(path.join(temporary, name, 'LICENSE'), 'dist-runtime/LICENSE');
    await writeFile('dist-runtime/version', `${cliNodeVersion}\n`);
  } finally {
    await rm(staged, { force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareCliRuntime();
