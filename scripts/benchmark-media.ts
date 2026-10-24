/** Reproducible synthetic codec + network model. Requires an external ffmpeg, never shipped. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { AdaptiveVideo } from '../src/host/adaptive';
import { JpegFramer } from '../src/host/protocol';

const exec = promisify(execFile);
const directory = await mkdtemp(path.join(tmpdir(), 'sim-relay-benchmark-'));
const scales = [1, 0.85, 0.7, 0.55, 0.4];
const qualities = [8, 8, 11, 14, 18]; // ffmpeg qscale, NOT idb's compressionQuality.
const sourceFrames = 90,
  fps = 30;
async function ffmpeg(args: string[]) {
  const start = performance.now();
  const result = await exec('ffmpeg', ['-hide_banner', '-y', ...args], {
    maxBuffer: 2 * 1024 * 1024,
  });
  return { ...result, elapsedMs: Math.round(performance.now() - start) };
}
try {
  for (let frame = 0; frame < sourceFrames; frame++) {
    const rows = Array.from({ length: 13 }, (_, n) => {
      const y = 380 + n * 150 - frame * 4;
      return `<rect x="52" y="${y}" width="1066" height="136" rx="14" fill="#fff"/><text x="92" y="${y + 56}" font-size="42" fill="#151719">${['Wi-Fi', 'Bluetooth', 'Display &amp; Brightness', 'Accessibility', 'Privacy &amp; Security'][n % 5]}</text><text x="92" y="${y + 102}" font-size="30" fill="#697170">Simulator setting ${n + 1} · scrolling sample</text>`;
    }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1170" height="2532"><rect width="1170" height="2532" fill="#f0f1f4"/>${rows}<rect width="1170" height="260" fill="#f0f1f4"/><text x="60" y="92" font-family="sans-serif" font-size="42">9:41</text><text x="60" y="225" font-family="sans-serif" font-size="96" font-weight="bold">Settings</text><rect x="70" y="2200" width="1030" height="140" rx="24" fill="${frame >= 30 && frame < 33 ? '#168af3' : '#d6e1ea'}"/><text x="120" y="2290" font-family="sans-serif" font-size="48">Interaction target</text></svg>`;
    await writeFile(
      path.join(directory, `frame${String(frame).padStart(3, '0')}.png`),
      new Resvg(svg).render().asPng(),
    );
  }
  const encoded: Buffer[][] = [],
    codecs: unknown[] = [];
  for (let level = 0; level < scales.length; level++) {
    const output = path.join(directory, `tier${level}.mjpeg`);
    const width = Math.round((1170 * scales[level]) / 2) * 2,
      height = Math.round((2532 * scales[level]) / 2) * 2;
    const result = await ffmpeg([
      '-framerate',
      '30',
      '-i',
      path.join(directory, 'frame%03d.png'),
      '-vf',
      `scale=${width}:${height}`,
      '-c:v',
      'mjpeg',
      '-q:v',
      String(qualities[level]),
      '-threads',
      '1',
      output,
    ]);
    const frames = new JpegFramer().push(await readFile(output));
    encoded.push(frames);
    const quality = await ffmpeg([
      '-framerate',
      '30',
      '-i',
      path.join(directory, 'frame%03d.png'),
      '-r',
      '30',
      '-i',
      output,
      '-filter_complex',
      `[1:v]scale=1170:2532[up];[0:v][up]ssim`,
      '-f',
      'null',
      '-',
    ]);
    codecs.push({
      codec: 'mjpeg',
      scale: scales[level],
      bytes: (await stat(output)).size,
      kbps: ((await stat(output)).size * 8) / 3000,
      encodeWallMs: result.elapsedMs,
      ssim: Number(quality.stderr.match(/All:([\d.]+)/)?.[1]),
    });
  }
  const h264 = path.join(directory, 'sample.h264');
  const h264Result = await ffmpeg([
    '-framerate',
    '30',
    '-i',
    path.join(directory, 'frame%03d.png'),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'zerolatency',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '1',
    h264,
  ]);
  const h264Quality = await ffmpeg([
    '-framerate',
    '30',
    '-i',
    path.join(directory, 'frame%03d.png'),
    '-r',
    '30',
    '-i',
    h264,
    '-lavfi',
    'ssim',
    '-f',
    'null',
    '-',
  ]);
  codecs.push({
    codec: 'libx264-crf23-veryfast-zerolatency',
    scale: 1,
    bytes: (await stat(h264)).size,
    kbps: ((await stat(h264)).size * 8) / 3000,
    encodeWallMs: h264Result.elapsedMs,
    ssim: Number(h264Quality.stderr.match(/All:([\d.]+)/)?.[1]),
  });
  function model(adaptive: boolean, bandwidthKbps: number, rttMs: number) {
    let now = 0,
      queued = 0,
      sent = 0,
      dropped = 0,
      bytes = 0,
      maxQueued = 0;
    const delays: number[] = [],
      video = new AdaptiveVideo(30, () => now);
    video.configure({
      mode: 'auto',
      maxFps: 30,
      maxScale: 1,
      quality: 0.7,
      maxKbps: bandwidthKbps,
    });
    for (let frame = 0; frame < 1800; frame++) {
      now = (frame * 1000) / fps;
      queued = Math.max(0, queued - (bandwidthKbps * 125) / fps);
      const level = adaptive ? scales.findIndex((scale) => scale <= video.settings.scale) : 0;
      const data = encoded[Math.max(0, level)][frame % sourceFrames];
      const allow = adaptive ? video.allow(data.length, queued) : queued < 2 * 1024 * 1024;
      if (allow) {
        queued += data.length;
        bytes += data.length;
        sent++;
        delays.push((queued / (bandwidthKbps * 125)) * 1000 + rttMs / 2);
      } else dropped++;
      maxQueued = Math.max(maxQueued, queued);
      if (adaptive) video.sample();
    }
    delays.sort((a, b) => a - b);
    return {
      adaptive,
      bandwidthKbps,
      rttMs,
      durationSeconds: 60,
      sentFps: sent / 60,
      dropped,
      kbps: (bytes * 8) / 60000,
      maxQueuedBytes: maxQueued,
      estimatedTransportP95Ms: delays[Math.floor(delays.length * 0.95)],
      finalSettings: adaptive ? video.settings : { fps: 30, scale: 1, quality: 0.7 },
    };
  }
  const version = (await exec('ffmpeg', ['-version'])).stdout.split('\n')[0];
  console.log(
    JSON.stringify(
      {
        source:
          'Synthetic 1170×2532 Settings UI, 90 scrolling frames at 30 FPS; repeated for 60-second network model. Not a simulator or native idb encoder test.',
        version,
        platform: `${process.platform}/${process.arch}`,
        codecResults: codecs,
        networkResults: [
          model(false, 100000, 4),
          model(true, 100000, 4),
          model(false, 2000, 80),
          model(true, 2000, 80),
        ],
        limitations:
          'Software FFmpeg qscale differs from idb quality. SSIM is image similarity, not a text-readability test. Model estimates transport queue delay only, not input responsiveness or capture-to-display latency. No packet loss or real TCP.',
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
