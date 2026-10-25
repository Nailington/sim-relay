import path from 'node:path';
import { readFile, access } from 'node:fs/promises';
import { startWeb } from './server';
import { webConfig, webOptions } from './config';

declare const SIM_RELAY_WEB_BUNDLED: boolean;

async function main() {
  if (process.argv.includes('--help')) {
    console.log(`Sim Relay browser hosting
Usage: sim-relay-web [serve]

Runtime configuration:
  SIM_RELAY_WEB_CONFIG_FILE Absolute path to a private JSON file (chmod 600)
  JSON keys: users, hosts, bind, port, origin, cert, key
  users maps names to passwords (16+ characters); hosts lists HTTPS Mac origins.
  cert and key are absolute paths to the browser HTTPS certificate and private key.

Environment overrides:
  SIM_RELAY_WEB_USERS       JSON mapping of user names to passwords
  SIM_RELAY_WEB_HOSTS       Comma-separated HTTPS Mac host origins
  SIM_RELAY_WEB_PORT        Port (default 49301)
  SIM_RELAY_WEB_BIND        Bind address (default 127.0.0.1)
  SIM_RELAY_WEB_ORIGIN      Public browser origin; HTTPS for remote access
  SIM_RELAY_WEB_CERT        Absolute HTTPS certificate path (with KEY)
  SIM_RELAY_WEB_KEY         Absolute HTTPS private key path (with CERT)

For an HTTPS reverse proxy, bind to loopback and set origin to its public URL.
Use systemd or launchd for start, stop, restart, status and logs.
Browser setups are stored separately on each device and profile.`);
    return;
  }
  if (process.argv.slice(2).some((arg) => arg !== 'serve') || process.argv.length > 3)
    throw new Error('Usage: sim-relay-web [serve]. Run sim-relay-web --help for settings.');
  const config = await webConfig(process.env);
  const directory =
    typeof SIM_RELAY_WEB_BUNDLED !== 'undefined' && SIM_RELAY_WEB_BUNDLED
      ? path.join(__dirname, 'frontend')
      : path.resolve(path.dirname(process.argv[1]), '../../dist');
  try {
    await access(path.join(directory, 'index.html'));
  } catch {
    throw new Error(
      'Browser assets are missing. Reinstall Sim Relay, or run npm run build in a source checkout.',
    );
  }
  const host = await startWeb({
    ...webOptions(config, directory),
    tls:
      config.cert && config.key
        ? { cert: await readFile(config.cert), key: await readFile(config.key) }
        : undefined,
  });
  console.log(
    `Sim Relay browser workspace: ${host.origin}\nBrowser setups are stored separately on each device and profile.`,
  );
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      void host.close().then(
        () => process.exit(0),
        () => {
          console.error(
            'Browser service cleanup failed. Check the service logs before restarting.',
          );
          process.exit(1);
        },
      );
    });
}
void main().catch((error: Error) => {
  // JSON parser errors can include passwords. Configuration parsing uses fixed messages.
  console.error(error.message);
  process.exitCode = 1;
});
