/** Companion to validate-mac-media.ts. Reads private credentials without printing them. */
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { downloadRecording } from '../src/electron/media';

const [configuration, directory] = process.argv.slice(2);
if (!configuration || !directory?.startsWith('/tmp/sim-relay-media-'))
  throw new Error(
    'Pass the private transfer configuration and a private /tmp/sim-relay-media-* client directory.',
  );
try {
  const { profile, recording } = JSON.parse(await readFile(configuration, 'utf8'));
  profile.url = 'https://127.0.0.1:49329'; // User-owned SSH loopback forward; TLS pin remains intact.
  const target = path.join(directory, 'native-screen.mp4');
  await downloadRecording(profile, recording, target, new AbortController().signal, () => {});
  assert.equal((await stat(target)).size, recording.bytes);
  const run = promisify(execFile);
  const probe = JSON.parse(
    (
      await run(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_name,width,height,nb_frames:format=duration,size',
          '-of',
          'json',
          target,
        ],
        { timeout: 15000 },
      )
    ).stdout,
  );
  await run('ffmpeg', ['-v', 'error', '-i', target, '-f', 'null', '-'], { timeout: 30000 });
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(target)) hash.update(bytes);
  const receipt = {
    client: `${process.platform}/${process.arch}`,
    bytes: recording.bytes,
    sha256: hash.digest('hex'),
    pinnedTlsDownload: true,
    decodedWithoutErrors: true,
    ffprobe: probe,
  };
  await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(receipt));
} finally {
  await rm(configuration, { force: true });
}
