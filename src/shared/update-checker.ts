import https from 'node:https';
import { selectRelease, type UpdateChannel, type UpdateResult } from './updates';

const endpoint = 'https://api.github.com/repos/Nailington/sim-relay/releases';
export function readReleaseMetadata(url: string): Promise<{ entries: unknown[]; more: boolean }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: 8000,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Sim-Relay-update-check' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new Error(
              [403, 429].includes(res.statusCode ?? 0)
                ? 'GitHub is limiting update requests. Try again later or open the official releases page.'
                : 'Release information is unavailable. Try again later.',
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024)
            res.destroy(new Error('Release information exceeded its size limit.'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
            resolve({
              entries: Array.isArray(value) ? value : [value],
              more: /rel="next"/.test(String(res.headers.link ?? '')),
            });
          } catch {
            reject(new Error('GitHub returned invalid release information.'));
          }
        });
      },
    );
    // No redirects, cookies, GitHub credentials, Mac identities or pairing data are sent.
    req.on('timeout', () =>
      req.destroy(new Error('The update check timed out. Try again when online.')),
    );
    const deadline = setTimeout(
      () => req.destroy(new Error('The update check timed out. Try again when online.')),
      8000,
    );
    req.once('close', () => clearTimeout(deadline));
    req.on('error', reject);
  });
}

export function createUpdateChecker(options: {
  currentVersion: string;
  platform: string;
  arch: string;
  installation?: UpdateResult['installation'];
  read?: typeof readReleaseMetadata;
  now?: () => number;
}) {
  const cache = new Map<UpdateChannel, UpdateResult>();
  const pending = new Map<UpdateChannel, Promise<UpdateResult>>();
  const now = options.now ?? Date.now;
  return (channel: UpdateChannel = 'stable'): Promise<UpdateResult> => {
    if (channel !== 'stable' && channel !== 'preview')
      throw new Error('Choose a valid release channel.');
    const saved = cache.get(channel);
    if (saved && now() - Date.parse(saved.checkedAt) < 60_000) return Promise.resolve(saved);
    const existing = pending.get(channel);
    if (existing) return existing;
    const task = (async (): Promise<UpdateResult> => {
      const base = {
        currentVersion: options.currentVersion,
        channel,
        checkedAt: new Date(now()).toISOString(),
        installation: options.installation ?? ('unknown' as const),
      };
      try {
        const read = options.read ?? readReleaseMetadata;
        let entries: unknown[] = [];
        if (channel === 'stable') entries = (await read(`${endpoint}/latest`)).entries;
        else {
          for (let page = 1; page <= 5; page++) {
            const result = await read(`${endpoint}?per_page=100&page=${page}`);
            entries = entries.concat(result.entries);
            if (!result.more) break;
            if (page === 5)
              throw new Error(
                'The release catalogue is too large to check safely. Open the official releases page.',
              );
          }
        }
        const result = {
          ...base,
          ...selectRelease(
            entries,
            options.currentVersion,
            channel,
            options.installation === 'nix' ? 'nix' : options.platform,
            options.arch,
          ),
        };
        cache.set(channel, result);
        return result;
      } catch (error) {
        const message =
          error instanceof Error &&
          /GitHub|release|Release|update|Update|channel|version|online|catalogue/.test(
            error.message,
          )
            ? error.message
            : 'Could not check for updates. Check your connection and try again.';
        const result: UpdateResult = { ...base, state: 'unavailable', message };
        cache.set(channel, result);
        return result;
      }
    })().finally(() => pending.delete(channel));
    pending.set(channel, task);
    return task;
  };
}
