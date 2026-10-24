import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';

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
}
