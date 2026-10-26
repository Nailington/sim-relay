// Published packaging check: inspect the real application, not validation fixtures.
import { listPackage } from '@electron/asar';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const privateAsset =
  /(?:^|\/)(?:tests|\.private-validation|fixtures)(?:\/|$)|(?:^|\/)(?:benchmark-media\.ts|build-media-fixture\.mjs|validate-mac-media\.ts|validate-media-download\.ts|desktop-smoke\.cjs|ci-smoke\.mjs|mac-e2e\.ts)$/;
export async function checkPackagedApp(context) {
  const resources =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, 'Sim Relay.app/Contents/Resources')
      : path.join(context.appOutDir, 'resources');
  const entries = listPackage(path.join(resources, 'app.asar'));
  // Dependency packages have their own policies; this guard covers our source payload.
  if (entries.some((file) => !file.startsWith('/node_modules/') && privateAsset.test(file)))
    throw new Error('Private validation assets were included in the application archive.');
  if (context.electronPlatformName === 'win32') return;
  for (const file of ['web/web.cjs', 'web/frontend/index.html', 'bin/sim-relay-web'])
    await access(path.join(resources, file));
  if (!(await readdir(path.join(resources, 'web/frontend/assets'))).length)
    throw new Error('The packaged browser frontend has no assets.');
  const inspect = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.name === 'app.asar' || entry.name === 'node_modules') continue;
      if (privateAsset.test(path.relative(resources, file)))
        throw new Error('Private validation assets were included in application resources.');
      if (entry.isDirectory()) await inspect(file);
    }
  };
  await inspect(resources);
  if (context.electronPlatformName === 'darwin') {
    for (const file of ['bin/sim-relay-upgrade', 'bin/sim-relay-host', '../MacOS/Sim Relay'])
      await access(path.join(resources, file));
    const audioApp = path.join(resources, 'host/Sim Relay Audio.app/Contents');
    await access(path.join(audioApp, 'MacOS/sim-relay-audio'));
    const info = await readFile(path.join(audioApp, 'Info.plist'), 'utf8');
    if (
      !/<key>CFBundleIdentifier<\/key>\s*<string>dev\.simrelay\.audio<\/string>/.test(info) ||
      !/<key>LSUIElement<\/key>\s*<true\s*\/>/.test(info)
    )
      throw new Error('The packaged audio helper is missing its background app identity.');
  }
  console.log('Packaged browser command, frontend and private asset exclusion: PASS');
}
