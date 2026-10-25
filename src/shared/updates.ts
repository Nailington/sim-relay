export type UpdateChannel = 'stable' | 'preview';
export type InstallationMethod = 'homebrew' | 'nix' | 'installer' | 'other';
export interface UpdateResult {
  currentVersion: string;
  latestVersion?: string;
  channel: UpdateChannel;
  state: 'available' | 'current' | 'incompatible' | 'unavailable';
  checkedAt: string;
  notesUrl?: string;
  message?: string;
  installation: InstallationMethod | 'unknown' | 'web';
}
export const releasesUrl = 'https://github.com/Nailington/sim-relay/releases';

export function releaseLink(value: string) {
  try {
    const url = new URL(value);
    return (
      url.origin === 'https://github.com' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/Nailington\/sim-relay\/releases(?:\/tag\/[0-9A-Za-z.+-]+)?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

// SemVer precedence ignores build metadata and compares numeric identifiers numerically.
export function parseVersion(value: string) {
  if (value.length > 128) return;
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (!match) return;
  const pre = match[4]?.split('.') ?? [];
  if (pre.some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return;
  return { core: match.slice(1, 4).map(BigInt), pre };
}
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left),
    b = parseVersion(right);
  if (!a || !b) throw new Error('The release version is not valid.');
  for (let index = 0; index < 3; index++)
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index],
      y = b.pre[index];
    if (x === undefined || y === undefined)
      return Number(x !== undefined) - Number(y !== undefined);
    if (x === y) continue;
    const numericX = /^\d+$/.test(x),
      numericY = /^\d+$/.test(y);
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function selectRelease(
  entries: unknown[],
  current: string,
  channel: UpdateChannel,
  platform: string,
  arch: string,
) {
  if (!parseVersion(current)) throw new Error('This build has no comparable release version.');
  const releases = entries
    .flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const r = entry as Record<string, unknown>;
      if (r.draft !== false || typeof r.tag_name !== 'string') return [];
      const version = parseVersion(r.tag_name);
      if (!version || (channel === 'stable' && (r.prerelease === true || version.pre.length)))
        return [];
      return [{ tag: r.tag_name, assets: Array.isArray(r.assets) ? r.assets : [] }];
    })
    .sort((a, b) => compareVersions(b.tag, a.tag));
  const latest = releases[0];
  if (!latest) throw new Error('No published release is available for this channel.');
  const version = latest.tag.replace(/^v/, '');
  const platformName = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : platform;
  const suffix = `${platformName}-${arch}.`;
  const compatible =
    platform === 'browser' ||
    platform === 'nix' ||
    latest.assets.some((asset) => {
      if (!asset || typeof asset !== 'object') return false;
      const value = asset as Record<string, unknown>;
      return (
        value.state === 'uploaded' &&
        typeof value.name === 'string' &&
        value.name.startsWith('Sim-Relay-') &&
        value.name.includes(suffix)
      );
    });
  return {
    latestVersion: version,
    state:
      compareVersions(version, current) <= 0
        ? ('current' as const)
        : compatible
          ? ('available' as const)
          : ('incompatible' as const),
    notesUrl: `${releasesUrl}/tag/${latest.tag}`,
  };
}

export function upgradeGuidance(method: InstallationMethod, browser = false) {
  if (method === 'homebrew')
    return 'On the Mac, run sim-relay-upgrade. It stops a running background host before Homebrew replaces the app, then resumes it after a successful upgrade. If the installed release has no wrapper, save recordings, stop its background host, upgrade the cask, then start the new host only if it was running before. Displays disconnect during upgrades.';
  if (method === 'nix')
    return 'Update the pinned Sim Relay flake input or release tag, then rebuild your Nix profile or system. Save recordings before restarting any host or browser service.';
  if (browser)
    return 'Ask the hosting-service owner to update its installed Sim Relay package and restart the service. Browser workspaces disconnect during restart; save recordings first. Reload this page afterward.';
  if (method === 'installer')
    return 'Save recordings and stop sharing before replacing the app with the official installer for your OS and architecture. Restart the background host afterward if it was running.';
  return 'Update through the package manager or deployment tool that installed Sim Relay. Save recordings and stop the host before replacing its runtime; restart it afterward if it was running.';
}
