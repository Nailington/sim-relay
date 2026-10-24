// Builds only a private simulator test fixture. Never installs it or changes simulator data.
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = process.argv[2];
if (process.platform !== 'darwin' || !root?.startsWith('/tmp/sim-relay-media-'))
  throw new Error('Use a private /tmp/sim-relay-media-* directory on a Mac.');
const app = path.join(root, 'fixtures/MediaValidation.app');
await mkdir(app, { recursive: true, mode: 0o700 });
await writeFile(
  path.join(app, 'Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.simrelay.validation.media</string>
<key>CFBundleExecutable</key><string>MediaValidation</string>
<key>CFBundleName</key><string>Sim Relay Media Validation</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>MinimumOSVersion</key><string>18.0</string>
<key>LSRequiresIPhoneOS</key><true/>
<key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
<key>UILaunchScreen</key><dict/>
<key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationPortrait</string><string>UIInterfaceOrientationLandscapeLeft</string><string>UIInterfaceOrientationLandscapeRight</string><string>UIInterfaceOrientationPortraitUpsideDown</string></array>
</dict></plist>`,
);
const rate = 48000,
  pcm = Buffer.alloc(rate * 2);
for (let sample = 0; sample < rate; sample++)
  pcm.writeInt16LE(
    sample < 4800 ? Math.round(3276 * Math.sin((2 * Math.PI * 880 * sample) / rate)) : 0,
    sample * 2,
  );
const header = Buffer.alloc(44);
header.write('RIFF');
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(rate, 24);
header.writeUInt32LE(rate * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);
await writeFile(path.join(app, 'pulse.wav'), Buffer.concat([header, pcm]));
const run = promisify(execFile);
const sdk = (
  await run('/usr/bin/xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'])
).stdout.trim();
await run(
  '/usr/bin/xcrun',
  [
    'swiftc',
    '-parse-as-library',
    '-swift-version',
    '6',
    '-strict-concurrency=complete',
    '-sdk',
    sdk,
    '-target',
    `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-ios18.0-simulator`,
    'scripts/fixtures/MediaValidation.swift',
    '-o',
    path.join(app, 'MediaValidation'),
    '-framework',
    'UIKit',
    '-framework',
    'AVFoundation',
  ],
  { timeout: 120000, maxBuffer: 1024 * 1024 },
);
await run('/usr/bin/codesign', ['--force', '--sign', '-', app], { timeout: 30000 });
console.log(JSON.stringify({ app, bundleId: 'dev.simrelay.validation.media', installed: false }));
