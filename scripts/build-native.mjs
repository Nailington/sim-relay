import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function buildNativeAudio() {
  if (process.platform !== 'darwin' || process.env.SIM_RELAY_SKIP_NATIVE_AUDIO === '1') return;
  await mkdir('dist-host', { recursive: true });
  await promisify(execFile)(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-parse-as-library',
      '-swift-version',
      '6',
      '-strict-concurrency=complete',
      '-O',
      '-target',
      `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`,
      'native/AudioCapture.swift',
      'native/AudioIPC.swift',
      '-o',
      'dist-host/sim-relay-audio',
      '-framework',
      'ScreenCaptureKit',
      '-framework',
      'CoreMedia',
      '-framework',
      'AudioToolbox',
      '-Xlinker',
      '-sectcreate',
      '-Xlinker',
      '__TEXT',
      '-Xlinker',
      '__info_plist',
      '-Xlinker',
      'native/audio-info.plist',
    ],
    { timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  const bundle = path.join('dist-host', 'Sim Relay Audio.app');
  const contents = path.join(bundle, 'Contents');
  await mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await copyFile('dist-host/sim-relay-audio', path.join(contents, 'MacOS/sim-relay-audio'));
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const info = (await readFile('native/audio-info.plist', 'utf8')).replace(
    '</dict>',
    `<key>CFBundleExecutable</key><string>sim-relay-audio</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string></dict>`,
  );
  await writeFile(path.join(contents, 'Info.plist'), info);
  // Development builds have a valid app identity; the release signer replaces this
  // ad-hoc signature with the app's stable Developer ID identity when configured.
  await promisify(execFile)('/usr/bin/codesign', [
    '--force', '--sign', '-', '--identifier', 'dev.simrelay.audio', bundle,
  ]);
}
