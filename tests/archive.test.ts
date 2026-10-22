import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { extractAppArchive } from '../src/host/archive';
test('extracts an app privately with executable permissions and removes its staging directory', async () => {
  const archive = Buffer.from(
    zipSync({
      'Example.app/Info.plist': strToU8('plist'),
      'Example.app/Example': strToU8('binary'),
      '__MACOSX/metadata': strToU8('ignored'),
    }),
  );
  const app = await extractAppArchive(archive);
  assert.equal(await readFile(path.join(app.appPath, 'Example'), 'utf8'), 'binary');
  if (process.platform !== 'win32')
    assert.equal((await stat(path.join(app.appPath, 'Example'))).mode & 0o111, 0o111);
  await app.close();
  await assert.rejects(stat(app.appPath));
});
test('rejects traversal, absolute paths, ambiguous bundles, and missing app metadata', async () => {
  const cases: Record<string, Uint8Array>[] = [
    { '../evil.app/Info.plist': strToU8('bad') },
    { '/evil.app/Info.plist': strToU8('bad') },
    { 'App.app/Info.plist': strToU8('ok'), 'Other.app/Info.plist': strToU8('bad') },
    { 'App.app/executable': strToU8('missing plist') },
  ];
  for (const files of cases) await assert.rejects(extractAppArchive(Buffer.from(zipSync(files))));
});
