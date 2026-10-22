import { homedir } from 'node:os';
import path from 'node:path';
import { startHost } from './server';
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
