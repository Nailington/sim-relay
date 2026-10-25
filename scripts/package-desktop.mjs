// CI entry point: unsigned builds work without secrets; requested signing fails closed.
import { build, Platform, Arch } from 'electron-builder';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkPackagedApp } from './check-packaged-app.mjs';

const [platform, arch] = process.argv.slice(2);
const platforms = { mac: Platform.MAC, windows: Platform.WINDOWS, linux: Platform.LINUX };
const nativePlatforms = { mac: 'darwin', windows: 'win32', linux: 'linux' };
if (!platforms[platform] || !['x64', 'arm64'].includes(arch))
  throw new Error('Usage: node scripts/package-desktop.mjs <mac|windows|linux> <x64|arm64>');
if (nativePlatforms[platform] !== process.platform || arch !== process.arch)
  throw new Error('CI packages must be built on matching native hardware.');

const signed =
  process.env.SIM_RELAY_RELEASE === 'true' &&
  process.env[platform === 'mac' ? 'MACOS_SIGNING_ENABLED' : 'WINDOWS_SIGNING_ENABLED'] ===
    'true' &&
  platform !== 'linux';
const required =
  platform === 'mac'
    ? ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY_P8', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
    : ['CSC_LINK', 'CSC_KEY_PASSWORD'];
if (signed && required.some((name) => !process.env[name]))
  throw new Error(`Signing enabled: configure every required secret (${required.join(', ')}).`);

let temporary;
try {
  if (signed && platform === 'mac') {
    temporary = await mkdtemp(path.join(tmpdir(), 'sim-relay-signing-'));
    process.env.APPLE_API_KEY = path.join(temporary, 'AuthKey.p8');
    await writeFile(process.env.APPLE_API_KEY, process.env.APPLE_API_KEY_P8, { mode: 0o600 });
  }
  if (!signed) {
    delete process.env.CSC_LINK;
    delete process.env.CSC_KEY_PASSWORD;
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  }
  await build({
    targets: platforms[platform].createTarget(undefined, Arch[arch]),
    publish: 'never',
    config: {
      forceCodeSigning: signed,
      afterPack: checkPackagedApp,
      ...(platform === 'mac'
        ? {
            mac: signed
              ? { hardenedRuntime: true, notarize: true }
              : { identity: '-', hardenedRuntime: false, notarize: false },
          }
        : {}),
    },
  });
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
