import type { HostEntry, Profile } from './types';

export const MAX_MAC_ADDRESSES = 6;

export function macAddress(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048)
    throw new Error('Enter an HTTPS Mac address of up to 2048 characters.');
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Enter an HTTPS Mac address, such as https://studio-mac.local:49300.');
  return url.origin;
}

/** Old single-address profiles migrate without changing identity or credentials. */
export function macAddresses(host: Pick<HostEntry, 'url' | 'addresses'>): string[] {
  if (
    host.addresses !== undefined &&
    (!Array.isArray(host.addresses) || host.addresses.length > MAX_MAC_ADDRESSES)
  )
    throw new Error(`Save up to ${MAX_MAC_ADDRESSES} addresses for each Mac.`);
  const addresses = [...new Set([host.url, ...(host.addresses ?? [])].map(macAddress))];
  if (addresses.length > MAX_MAC_ADDRESSES)
    throw new Error(`Save up to ${MAX_MAC_ADDRESSES} addresses for each Mac.`);
  return addresses;
}

export function editMacAddress<T extends HostEntry>(
  host: T,
  action: 'add' | 'remove' | 'prefer',
  value: string,
): T {
  const address = macAddress(value);
  let addresses = macAddresses(host);
  if (action === 'add')
    addresses = macAddresses({ url: host.url, addresses: [...new Set([...addresses, address])] });
  else {
    if (!addresses.includes(address)) throw new Error('Choose a verified address for this Mac.');
    if (action === 'remove') addresses = addresses.filter((item) => item !== address);
  }
  if (!addresses.length) throw new Error('Keep at least one address for this Mac.');
  const url =
    action === 'prefer' ? address : addresses.includes(host.url) ? host.url : addresses[0];
  return {
    ...host,
    url,
    addresses,
    currentRoute:
      action === 'prefer' || !addresses.includes(host.currentRoute ?? '')
        ? undefined
        : host.currentRoute,
  };
}

/** Discovery names and advertised fingerprints are untrusted; only saved verified aliases deduplicate. */
export function discoveredMacs(saved: HostEntry[], discovered: HostEntry[]): HostEntry[] {
  const aliases = new Set(saved.flatMap(macAddresses));
  return discovered.filter((host) => {
    try {
      return !aliases.has(macAddress(host.url));
    } catch {
      return true;
    }
  });
}

export function publicMac({
  token: _token,
  certificate: _certificate,
  ...host
}: Profile): HostEntry {
  return { ...host, addresses: macAddresses(host) };
}
