import https from 'node:https';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import type { Profile, Probe } from '../shared/types';
import { SessionFailure } from './session';
import { parseHostInfo } from '../shared/host-info';
import { remoteRecovery, recoveryMessages } from '../shared/migration';
import { macAddress, macAddresses } from '../shared/mac-routes';
import { terminalFailure } from './session';

export function hostUrl(value: string): URL {
  return new URL(macAddress(value));
}
export function tlsOptions(profile: Profile) {
  if (new X509Certificate(profile.certificate).fingerprint256 !== profile.fingerprint)
    throw new Error('This Mac’s certificate changed. Pair with the Mac again.');
  return {
    // Shared agents can resume TLS without re-running checkServerIdentity on older Node releases.
    agent: false as const,
    rejectUnauthorized: true,
    ca: profile.certificate,
    // Trust the verified leaf directly. Electron/BoringSSL otherwise rejects host
    // certificates without CA privileges before it reaches the fingerprint check.
    allowPartialTrustChain: true,
    checkServerIdentity: (_host: string, cert: { fingerprint256: string; raw: Buffer }) =>
      cert.fingerprint256 === profile.fingerprint &&
      cert.raw.equals(new X509Certificate(profile.certificate).raw)
        ? undefined
        : new Error('This Mac’s certificate changed. Pair with the Mac again.'),
  };
}

export const ROUTE_TIMEOUT_MS = 2000;

/** No HTTP headers or credentials enter a candidate route until its exact leaf is verified.
 * Every subsequent HTTP/WSS connection independently checks the same leaf (no shared agent).
 */
export async function verifyMacAddress(
  profile: Profile,
  value: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const url = hostUrl(value);
  const options = tlsOptions(profile);
  await new Promise<void>((resolve, reject) => {
    let verified = false;
    const socket = tls.connect({
      ...options,
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || 443),
      ...(!/^\[|^[\d.]+$/.test(url.hostname) ? { servername: url.hostname } : {}),
    });
    const cancel = () => socket.destroy(new DOMException('Connection canceled.', 'AbortError'));
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(
      () => socket.destroy(new Error('Cannot reach this Mac address.')),
      ROUTE_TIMEOUT_MS,
    );
    socket.once('secureConnect', () => {
      // Explicit leaf comparison also covers TLS implementations that skip identity callbacks.
      const peer = socket.getPeerCertificate();
      if (!peer.raw || !peer.raw.equals(new X509Certificate(profile.certificate).raw)) {
        socket.destroy(
          new SessionFailure('This Mac’s certificate changed. Pair with the Mac again.', true),
        );
        return;
      }
      verified = true;
      // Flush the TLS Finished/close-notify records. Destroying immediately on
      // secureConnect can strand a server-side handshake until its idle timeout.
      socket.end();
    });
    socket.once('error', reject);
    socket.once('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (verified) resolve();
      else reject(new Error('Connection interrupted before the Mac could be verified.'));
    });
  });
  signal?.throwIfAborted();
  return url.origin;
}

/** At most six credential-free attempts, each with a two-second wall-clock deadline.
 * Selection is the only fallback loop. Callers dispatch exactly once after it returns.
 */
export async function selectMacRoute(profile: Profile, signal?: AbortSignal): Promise<Profile> {
  const addresses = macAddresses(profile);
  const routes = [
    ...new Set([
      ...(addresses.includes(profile.currentRoute ?? '') ? [profile.currentRoute!] : []),
      ...addresses,
    ]),
  ];
  for (const route of routes) {
    signal?.throwIfAborted();
    try {
      await verifyMacAddress(profile, route, signal);
      signal?.throwIfAborted();
      profile.currentRoute = route;
      return { ...profile, url: route, addresses: [route], currentRoute: route };
    } catch (error) {
      signal?.throwIfAborted();
      // A changed certificate is a re-pair event, never a reason to relax verification.
      if (terminalFailure(error)) throw error;
    }
  }
  throw new Error(
    'Cannot reach this Mac at any saved address. Keep it awake and sharing, check the network, then retry.',
  );
}
export async function probeHost(value: string, signal?: AbortSignal): Promise<Probe> {
  const url = hostUrl(value);
  // Bootstrap requests never include credentials. The user verifies this certificate on the Mac before pairing.
  return new Promise((resolve, reject) => {
    const req = https.get(
      new URL('/info', url),
      { rejectUnauthorized: false, agent: false, timeout: 8000, signal },
      (res) => {
        const cert = (res.socket as import('node:tls').TLSSocket).getPeerCertificate();
        if (!cert.raw) {
          res.destroy();
          reject(new Error('The Mac did not provide a TLS certificate.'));
          return;
        }
        const certificate = new X509Certificate(cert.raw).toString();
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > 65536) res.destroy(new Error('Unexpected host response.'));
        });
        res.on('error', (error) => {
          clearTimeout(deadline);
          reject(error);
        });
        res.on('end', () => {
          clearTimeout(deadline);
          try {
            if (res.statusCode !== 200)
              throw new Error(`The host returned HTTP ${res.statusCode}.`);
            const info = parseHostInfo(JSON.parse(data));
            resolve({ info, certificate, fingerprint: cert.fingerprint256, url: url.origin });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error('Cannot reach this Mac.')), 8000);
    req.once('close', () => clearTimeout(deadline));
    req.on('timeout', () =>
      req.destroy(
        new Error('Cannot reach this Mac. Check its address, host service, and firewall.'),
      ),
    );
    req.on('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
  });
}
export async function remoteRequest(
  profile: Profile,
  method: string,
  pathname: string,
  body?: unknown,
  timeoutOrSignal: number | AbortSignal = method === 'GET' ? 15000 : 130000,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (
    !['GET', 'POST'].includes(method) ||
    !/^\/(info|permissions|devices(?:\/[^/]+\/(?:boot|shutdown|screenshot|url|location|appearance|install|text))?|command|pair)$/.test(
      pathname,
    )
  )
    throw new Error('Unsupported host action.');
  const abortSignal = typeof timeoutOrSignal === 'number' ? signal : timeoutOrSignal;
  const route = await selectMacRoute(profile, abortSignal);
  abortSignal?.throwIfAborted();
  const url = new URL(pathname, hostUrl(route.url));
  const encoded =
    body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        ...tlsOptions(route),
        timeout:
          typeof timeoutOrSignal === 'number' ? timeoutOrSignal : method === 'GET' ? 15000 : 130000,
        signal: typeof timeoutOrSignal === 'number' ? signal : timeoutOrSignal,
        headers: {
          Authorization: `Bearer ${profile.token}`,
          ...(encoded
            ? {
                'Content-Type': Buffer.isBuffer(encoded) ? 'application/zip' : 'application/json',
                'Content-Length': Buffer.byteLength(encoded),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let length = 0;
        res.on('data', (chunk) => {
          length += chunk.length;
          if (length > 32 * 1024 * 1024) res.destroy(new Error('Host response exceeded 32 MB.'));
          else chunks.push(chunk);
        });
        res.on('error', (error) => {
          clearTimeout(deadline);
          reject(error);
        });
        res.on('end', () => {
          clearTimeout(deadline);
          const buffer = Buffer.concat(chunks);
          if ((res.statusCode ?? 500) >= 400) {
            try {
              const data = JSON.parse(buffer.toString());
              const recovery = remoteRecovery(profile, pathname, res.statusCode ?? 500, data.code);
              reject(
                new SessionFailure(
                  recovery?.message ?? data.error ?? `Host returned HTTP ${res.statusCode}.`,
                  [401, 403, 404, 409, 426].includes(res.statusCode ?? 0),
                  recovery?.code ?? data.code,
                ),
              );
            } catch {
              reject(new Error(`Host returned HTTP ${res.statusCode}.`));
            }
          } else resolve(buffer);
        });
      },
    );
    const deadline = setTimeout(
      () =>
        req.destroy(
          new Error(
            'The Mac took too long to respond. Check its state before retrying this action.',
          ),
        ),
      typeof timeoutOrSignal === 'number' ? timeoutOrSignal : method === 'GET' ? 15000 : 130000,
    );
    req.once('close', () => clearTimeout(deadline));
    req.on('timeout', () =>
      req.destroy(new Error('The Mac took too long to respond. Check the host and reconnect.')),
    );
    req.on('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    if (encoded) req.write(encoded);
    req.end();
  });
}

export async function pairRemoteClient(
  profile: Profile,
  probe: Probe,
  clientName: string,
): Promise<Profile> {
  if (!probe.info.clientAuthorization) {
    try {
      await remoteRequest(profile, 'GET', '/devices');
    } catch (error) {
      if (
        error instanceof SessionFailure &&
        ['legacy_pairing', 'authorization_required'].includes(error.code ?? '')
      )
        throw new SessionFailure(recoveryMessages.legacy_code_invalid, true, 'legacy_code_invalid');
      throw error;
    }
    return { ...profile, authorizationMode: 'legacy' };
  }
  const result = JSON.parse(
    (await remoteRequest(profile, 'POST', '/pair', { name: clientName })).toString(),
  );
  if (typeof result.token !== 'string' || !/^[\w-]{43}$/.test(result.token))
    throw new Error('The Mac returned an invalid client credential. Pair again.');
  return { ...profile, token: result.token, authorizationMode: 'client' };
}
