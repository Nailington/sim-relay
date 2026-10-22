import { unzipSync } from 'fflate';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Extract regular files only. Archive paths can never escape the private directory. */
export async function extractAppArchive(archive: Buffer) {
  if (archive.length > 128 * 1024 * 1024)
    throw new Error('Choose an app archive smaller than 128 MB.');
  let total = 0,
    count = 0;
  const roots = new Set<string>();
  const files = unzipSync(archive, {
    filter: (file) => {
      const segments = file.name.split('/');
      if (
        file.name.includes('\\') ||
        file.name.includes('\0') ||
        file.name.startsWith('/') ||
        segments.some((s) => s === '..' || s === '.' || s.includes(':'))
      )
        throw new Error('The app archive contains an unsafe path.');
      if (segments[0] === '__MACOSX' || file.name.endsWith('/')) return false;
      const app = segments.findIndex((s) => s.endsWith('.app'));
      if (app < 0) return false;
      if (++count > 20000 || (total += file.originalSize) > 512 * 1024 * 1024)
        throw new Error('The expanded app exceeds the 512 MB or 20,000 file limit.');
      roots.add(segments.slice(0, app + 1).join('/'));
      return true;
    },
  });
  if (roots.size !== 1) throw new Error('The ZIP must contain exactly one simulator .app bundle.');
  const root = [...roots][0];
  if (!files[`${root}/Info.plist`])
    throw new Error('The app bundle has no Info.plist. Choose a simulator build.');
  const directory = await mkdtemp(path.join(tmpdir(), 'sim-relay-app-'));
  try {
    for (const [name, data] of Object.entries(files)) {
      const destination = path.join(directory, name);
      await mkdir(path.dirname(destination), { recursive: true });
      // ZIP symlinks become regular files; no archive-provided links are followed.
      await writeFile(destination, data, { flag: 'wx', mode: 0o755 });
    }
    return {
      appPath: path.join(directory, root),
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
