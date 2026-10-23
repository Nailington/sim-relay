import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { startWeb } from './server';

async function main() {
  if (process.argv.includes('--help')) {
    console.log(`Sim Relay browser hosting
Run npm run build, then npm run web.

Required configuration:
  SIM_RELAY_WEB_USERS       JSON mapping user names to passwords (16+ characters)
  SIM_RELAY_WEB_HOSTS       Comma-separated HTTPS Mac host origins
Optional:
  SIM_RELAY_WEB_PORT        Port (default 49301)
  SIM_RELAY_WEB_BIND        Bind address (default 127.0.0.1)
  SIM_RELAY_WEB_ORIGIN      Public browser origin, HTTPS for remote access
  SIM_RELAY_WEB_CERT        HTTPS certificate path (with KEY)
  SIM_RELAY_WEB_KEY         HTTPS private key path (with CERT)

For an HTTPS reverse proxy, bind to loopback and set ORIGIN to its public URL.
Credentials are browser-local. This service never stores a global workspace.`);
    return;
  }
  const port = Number(process.env.SIM_RELAY_WEB_PORT ?? 49301);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('SIM_RELAY_WEB_PORT must be between 1 and 65535.');
  const cert = process.env.SIM_RELAY_WEB_CERT,
    key = process.env.SIM_RELAY_WEB_KEY;
  if (!!cert !== !!key) throw new Error('Set both SIM_RELAY_WEB_CERT and SIM_RELAY_WEB_KEY.');
  let users: Record<string, string>;
  try {
    users = JSON.parse(process.env.SIM_RELAY_WEB_USERS ?? '{}');
  } catch {
    throw new Error('SIM_RELAY_WEB_USERS must be a valid JSON mapping of user names to passwords.');
  }
  if (
    !users ||
    typeof users !== 'object' ||
    Array.isArray(users) ||
    Object.values(users).some((value) => typeof value !== 'string')
  )
    throw new Error('SIM_RELAY_WEB_USERS must map user names to passwords.');
  const host = await startWeb({
    port,
    bind: process.env.SIM_RELAY_WEB_BIND,
    publicOrigin: process.env.SIM_RELAY_WEB_ORIGIN,
    users,
    allowedHosts: (process.env.SIM_RELAY_WEB_HOSTS ?? '').split(',').filter(Boolean),
    directory: path.resolve('dist'),
    tls: cert && key ? { cert: await readFile(cert), key: await readFile(key) } : undefined,
  });
  console.log(
    `Sim Relay browser workspace: ${host.origin}\nKeep this service running. Browser setups are stored separately on each device/profile.`,
  );
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      void host.close().finally(() => process.exit(0));
    });
}
void main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
