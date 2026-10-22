import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { releaseVersion, assembleRelease, shouldUpdateCask } from './release-lib.mjs';

const [command, ...args] = process.argv.slice(2);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (command === 'validate') {
  const result = releaseVersion(process.env.RELEASE_TAG, pkg.version);
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version)
    throw new Error('package-lock.json version must match package.json. Use npm version.');
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `version=${result.version}\nprerelease=${result.prerelease}\n`,
    );
  console.log(`Validated ${process.env.RELEASE_TAG}`);
} else if (command === 'assemble') {
  const notes = await assembleRelease({
    input: args[0],
    output: args[1],
    version: pkg.version,
    repository: process.env.GITHUB_REPOSITORY,
    macSigned: process.env.MACOS_SIGNING_ENABLED === 'true',
    windowsSigned: process.env.WINDOWS_SIGNING_ENABLED === 'true',
  });
  await writeFile(args[2], notes);
} else if (command === 'update-tap') {
  const incoming = await readFile(args[0], 'utf8');
  let existing;
  try {
    existing = await readFile('Casks/sim-relay.rb', 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (shouldUpdateCask(existing, incoming)) {
    await mkdir('Casks', { recursive: true });
    await writeFile('Casks/sim-relay.rb', incoming);
    console.log('Updated Homebrew cask.');
  } else console.log('Homebrew already has this version or a newer version.');
} else
  throw new Error(
    'Usage: release.mjs validate | assemble <input> <output> <notes> | update-tap <cask>',
  );
