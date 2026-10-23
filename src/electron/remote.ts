import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import type { Profile, Probe } from '../shared/types';
import { parseHostInfo } from '../shared/host-info';

export function hostUrl(value: string): URL {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Enter an HTTPS host address, such as https://studio-mac.local:49300.');
  return url;
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
    checkServerIdentity: (_host: string, cert: { fingerprint256: string }) =>
      cert.fingerprint256 === profile.fingerprint
        ? undefined
        : new Error('This Mac’s certificate changed. Pair with the Mac again.'),
  };
}
export async function probeHost(value: string): Promise<Probe> {
  const url = hostUrl(value);
  // Bootstrap requests never include credentials. The user verifies this certificate on the Mac before pairing.
  return new Promise((resolve, reject) => {
    const req = https.get(
      new URL('/info', url),
      { rejectUnauthorized: false, agent: false, timeout: 8000 },
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
        res.on('error', reject);
        res.on('end', () => {
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
    req.on('timeout', () =>
      req.destroy(
        new Error('Cannot reach this Mac. Check its address, host service, and firewall.'),
      ),
    );
    req.on('error', reject);
  });
}
export async function remoteRequest(
  profile: Profile,
  method: string,
  pathname: string,
  body?: unknown,
  timeoutMs = 130000,
): Promise<Buffer> {
  if (
    !['GET', 'POST'].includes(method) ||
    !/^\/(devices(?:\/[^/]+\/(?:boot|shutdown|screenshot|url|location|appearance|install|text))?|command)$/.test(
      pathname,
    )
  )
    throw new Error('Unsupported host action.');
  const url = new URL(pathname, hostUrl(profile.url));
  const encoded =
    body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        ...tlsOptions(profile),
        timeout: timeoutMs,
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
        res.on('error', reject);
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if ((res.statusCode ?? 500) >= 400) {
            try {
              const data = JSON.parse(buffer.toString());
              reject(new Error(data.error ?? `Host returned HTTP ${res.statusCode}.`));
            } catch {
              reject(new Error(`Host returned HTTP ${res.statusCode}.`));
            }
          } else resolve(buffer);
        });
      },
    );
    req.on('timeout', () =>
      req.destroy(new Error('The Mac took too long to respond. Check the host and reconnect.')),
    );
    req.on('error', reject);
    if (encoded) req.write(encoded);
    req.end();
  });
}
