import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))
  throw new Error('Run this check on the Linux architecture that built the packages.');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const debArch = process.arch === 'x64' ? 'amd64' : 'arm64';
const rpmArch = process.arch === 'x64' ? 'x86_64' : 'aarch64';
function query(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${command} package inspection failed.`);
  return result.stdout.trim();
}
for (const [format, arch, command, metadataArgs, contentsArgs] of [
  ['deb', debArch, 'dpkg-deb', ['-f'], ['-c']],
  ['rpm', rpmArch, 'rpm', ['-qp', '--queryformat', '%{NAME}\n%{ARCH}\n'], ['-qpl']],
]) {
  const file = `release/Sim-Relay-${version}-linux-${arch}.${format}`;
  const metadata =
    format === 'deb'
      ? `${query(command, [...metadataArgs, file, 'Package'])}\n${query(command, [...metadataArgs, file, 'Architecture'])}`
      : query(command, [...metadataArgs, file]);
  if (metadata !== `sim-relay\n${arch}`)
    throw new Error(`${format} package name or architecture is incorrect.`);
  const contents = query(command, [...contentsArgs, file]);
  if (
    !contents.includes('/resources/app.asar') ||
    !contents.includes('/applications/dev.simrelay.desktop')
  )
    throw new Error(`${format} is missing the application archive or desktop menu entry.`);
  console.log(`${format.toUpperCase()} metadata and payload: PASS (${arch})`);
}
