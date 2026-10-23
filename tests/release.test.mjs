import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  releaseVersion,
  artifactNames,
  homebrewCask,
  assembleRelease,
  shouldUpdateCask,
} from '../scripts/release-lib.mjs';

test('release tags must match the package version and documented prerelease channels', () => {
  assert.deepEqual(releaseVersion('v1.2.3', '1.2.3'), { version: '1.2.3', prerelease: false });
  assert.equal(releaseVersion('v1.2.3-rc.1', '1.2.3-rc.1').prerelease, true);
  for (const [tag, version] of [
    ['v1.2.4', '1.2.3'],
    ['1.2.3', '1.2.3'],
    ['v01.2.3', '01.2.3'],
    ['v1.2.3-beta.01', '1.2.3-beta.01'],
    ['v1.2.3"', '1.2.3"'],
  ])
    assert.throws(() => releaseVersion(tag, version));
});

test('release assembly requires every architecture and checksums the actual installer bytes', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sim-relay-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input');
  await mkdir(input);
  const options = {
    input,
    output: path.join(dir, 'output'),
    version: '1.2.3',
    repository: 'Nailington/sim-relay',
    macSigned: false,
    windowsSigned: false,
  };
  await assert.rejects(assembleRelease(options), /all six targets/);
  for (const name of artifactNames(options.version)) await writeFile(path.join(input, name), name);
  // Publishing must fail if any of the newly supported packages is absent.
  for (const name of [
    'Sim-Relay-1.2.3-windows-arm64.exe',
    'Sim-Relay-1.2.3-linux-amd64.deb',
    'Sim-Relay-1.2.3-linux-arm64.deb',
    'Sim-Relay-1.2.3-linux-x86_64.rpm',
    'Sim-Relay-1.2.3-linux-aarch64.rpm',
  ]) {
    await unlink(path.join(input, name));
    await assert.rejects(assembleRelease(options), /all six targets/);
    await writeFile(path.join(input, name), name);
  }
  const notes = await assembleRelease(options);
  assert.match(notes, /not notarized/);
  const cask = await readFile(path.join(options.output, 'sim-relay.rb'), 'utf8');
  const digest = createHash('sha256').update('Sim-Relay-1.2.3-mac-arm64.dmg').digest('hex');
  assert.ok(cask.includes(digest));
  assert.match(cask, /arch arm: "arm64", intel: "x64"/);
  const sums = await readFile(path.join(options.output, 'SHA256SUMS'), 'utf8');
  for (const name of await readdir(options.output)) {
    if (name === 'SHA256SUMS') continue;
    const expected = createHash('sha256')
      .update(await readFile(path.join(options.output, name)))
      .digest('hex');
    assert.ok(sums.includes(`${expected}  ${name}\n`));
  }
  await assert.rejects(assembleRelease(options), /must be empty/);
  await writeFile(path.join(input, 'unexpected.zip'), 'junk');
  await assert.rejects(
    assembleRelease({ ...options, output: path.join(dir, 'other') }),
    /all six targets/,
  );
});

test('Homebrew rejects missing checksums, prereleases, and version downgrades', () => {
  const hashes = (v) =>
    Object.fromEntries(
      ['arm64', 'x64'].map((arch) => [`Sim-Relay-${v}-mac-${arch}.dmg`, 'a'.repeat(64)]),
    );
  const cask = (v) => homebrewCask(v, hashes(v), 'Nailington/sim-relay');
  assert.throws(() => homebrewCask('1.2.3', {}, 'Nailington/sim-relay'), /checksum/);
  assert.throws(() => homebrewCask('1.2.3-rc.1', {}, 'Nailington/sim-relay'), /stable/);
  assert.equal(shouldUpdateCask(undefined, cask('1.2.3')), true);
  assert.equal(shouldUpdateCask(cask('1.2.3'), cask('1.2.3')), false);
  assert.equal(shouldUpdateCask(cask('1.2.3'), cask('1.2.2')), false);
  assert.equal(shouldUpdateCask(cask('1.9.0'), cask('1.10.0')), true);
});
