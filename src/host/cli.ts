import { homedir } from 'node:os';
import path from 'node:path';
import { writeFile, rename, rm } from 'node:fs/promises';
import { startHost } from './server';
import { backgroundCommand, serviceStatusFile, printHostStatus } from './service';
import packageMetadata from '../../package.json';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(`Sim Relay host ${packageMetadata.version}

Usage: sim-relay-host [command]

Commands:
  start, --background   Run in the background and start again at login (macOS)
  stop                 Stop the background host and disable starting at login
  restart              Restart the background host, keeping its saved settings
  status               Show background host status and pairing details
  logs                 Show the last 50 lines of background host output
  serve                Run in this Terminal (the default); Ctrl+C stops sharing
  --help, -h           Show this help
  --version, -v        Show the installed version

Requires Xcode, an installed iOS runtime, and idb_companion.

Environment (saved when starting the background host):
  SIM_RELAY_PORT         Listening port (default: 49300)
  SIM_RELAY_BIND         Listening address (default: 0.0.0.0)
  SIM_RELAY_STATE_DIR    Pairing state (default: ~/.sim-relay)
  IDB_COMPANION_PATH    Custom idb_companion executable

Only run one host at a time. Stop sharing in the desktop app before starting here.`);
    return;
  }
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
    console.log(packageMetadata.version);
    return;
  }
  if (args.length > 1) throw new Error('Run sim-relay-host --help for usage.');
  const command = args[0] ?? 'serve';
  if (await backgroundCommand(command)) return;
  if (command !== 'serve') throw new Error('Unknown command. Run sim-relay-host --help for usage.');
  const port = Number(process.env.SIM_RELAY_PORT ?? 49300);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('SIM_RELAY_PORT must be between 1 and 65535.');
  const directory = path.resolve(
    process.env.SIM_RELAY_STATE_DIR ?? path.join(homedir(), '.sim-relay'),
  );
  const host = await startHost({
    directory,
    port,
    bind: process.env.SIM_RELAY_BIND ?? '0.0.0.0',
  });
  const background = process.env.SIM_RELAY_BACKGROUND === '1';
  const ready = serviceStatusFile(directory, process.pid);
  try {
    if (background) {
      const { token: _token, ...status } = host.status;
      const temporary = `${ready}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ pid: process.pid, status }), { mode: 0o600 });
      await rename(temporary, ready);
    }
    printHostStatus(host.status);
    console.log(
      background
        ? 'Running in the background. Use sim-relay-host stop to stop sharing.'
        : 'Keep this process running. Press Ctrl+C to stop sharing.',
    );
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => {
        if (stopping) return;
        stopping = true;
        void host
          .close()
          .catch((error: Error) => console.error(error.message))
          .finally(async () => {
            try {
              if (background) await rm(ready, { force: true });
            } finally {
              process.exit(0);
            }
          });
      });
  } catch (error) {
    await host.close();
    throw error;
  }
}

void main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
