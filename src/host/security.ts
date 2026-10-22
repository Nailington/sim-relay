import { randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generate } from 'selfsigned';

export async function identity(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const certPath = path.join(directory, 'host.pem'),
    keyPath = path.join(directory, 'host-key.pem'),
    tokenPath = path.join(directory, 'token');
  try {
    await Promise.all([readFile(certPath), readFile(keyPath)]);
  } catch {
    const pems = await generate([{ name: 'commonName', value: 'Sim Relay Host' }], {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notAfterDate: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
    });
    await writeFile(keyPath, pems.private, { mode: 0o600 });
    await writeFile(certPath, pems.cert, { mode: 0o600 });
  }
  let token: string;
  try {
    token = (await readFile(tokenPath, 'utf8')).trim();
  } catch {
    token = randomBytes(24).toString('base64url');
    await writeFile(tokenPath, token, { mode: 0o600 });
  }
  const cert = await readFile(certPath),
    key = await readFile(keyPath);
  return { cert, key, token, fingerprint: new X509Certificate(cert).fingerprint256 };
}
export function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7)),
    expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
