import { homedir } from 'node:os';
import path from 'node:path';
import { startHost } from './server';
import packageMetadata from '../../package.json';

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log(`Sim Relay host ${packageMetadata.version}

Usage: sim-relay-host [--help | --version]

Share this Mac's iOS simulators. Keep this process running; press Ctrl+C to stop.
Requires Xcode, an installed iOS runtime, and idb_companion.

Environment:
  SIM_RELAY_PORT         Listening port (default: 49300)
  SIM_RELAY_BIND         Listening address (default: 0.0.0.0)
  SIM_RELAY_STATE_DIR    Pairing state (default: ~/.sim-relay)
  IDB_COMPANION_PATH    Custom idb_companion executable

Only run one host at a time: stop sharing in the desktop app before starting here.`);
  process.exit(0);
}
if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
  console.log(packageMetadata.version);
  process.exit(0);
}
if (args.length) {
  console.error('Unknown arguments. Run sim-relay-host --help for usage.');
  process.exit(1);
}
const port = Number(process.env.SIM_RELAY_PORT ?? 49300);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('SIM_RELAY_PORT must be between 1 and 65535.');
startHost({
  directory: process.env.SIM_RELAY_STATE_DIR ?? path.join(homedir(), '.sim-relay'),
  port,
  bind: process.env.SIM_RELAY_BIND ?? '0.0.0.0',
})
  .then((host) => {
    console.log(
      `\nSim Relay host\n${host.status.url}\n${host.status.addresses?.join('\n')}\n\nPairing token: ${host.status.token}\nSHA-256 fingerprint: ${host.status.fingerprint}\n\nXcode: ${host.status.info?.xcode ? 'ready' : 'not found'}\nInput service: ${host.status.info?.companion ? 'ready' : 'install idb_companion'}\n\nKeep this process running. Press Ctrl+C to stop sharing.\n`,
    );
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.once(signal, () => {
        void host.close().then(() => process.exit(0));
      });
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
