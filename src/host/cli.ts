import { homedir } from 'node:os';
import path from 'node:path';
import { writeFile, rename, rm } from 'node:fs/promises';
import { startHost } from './server';
import {
  backgroundCommand,
  serviceStatusFile,
  serviceRetirementFile,
  printHostStatus,
} from './service';
import packageMetadata from '../../package.json';
import { createServiceManager } from './service-manager';
import type { AuthorizedClient } from './clients';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(`Sim Relay host ${packageMetadata.version}

Usage: sim-relay-host [command]

Commands:
  start, --background   Run persistently in the background (macOS)
  stop                 Stop the background host and disable starting at login
  restart              Restart the background host, keeping its saved settings
  status               Show observed status, version, and certificate fingerprint
  login on|off         Explicitly enable or disable starting at login
  settings             Show saved service settings as JSON
  configure JSON       Save service settings while stopped
  keep-awake on|off    Prevent idle system sleep only during active sessions
  upgrade prepare|resume|abort  Safely hand off a background host across app replacement
  logs                 Show the last 50 lines of background host output
  clients              List authorized clients and active displays
  revoke CLIENT_ID     Revoke one client and disconnect its displays
  permissions ID [REVISION JSON]  Inspect or replace client permissions
  pairing              Show the current single-use pairing code
  serve                Run in this Terminal (the default); Ctrl+C stops sharing
  --help, -h           Show this help
  --version, -v        Show the installed version

Requires Xcode, an installed iOS runtime, and idb_companion.

Environment (saved when starting the background host):
  SIM_RELAY_PORT         Listening port (default: 49300)
  SIM_RELAY_BIND         Listening address (default: 0.0.0.0)
  SIM_RELAY_STATE_DIR    Pairing state (default: ~/.sim-relay)
  IDB_COMPANION_PATH    Custom idb_companion executable
  SIM_RELAY_ENABLE_HOST_AUDIO  Set to 1 to allow sharing ALL Mac playback audio
  SIM_RELAY_AUDIO_HELPER       Custom compiled ScreenCaptureKit helper
  SIM_RELAY_KEEP_AWAKE         Set to 1 for initial idle-sleep opt-in (saved per state directory)

GUI and CLI manage the same saved background service. Stop disables starting at login.
Pairing, clients, and revoke use the selected saved service state directory.
Status never prints a pairing code. Use pairing to explicitly retrieve the current code.
Only run one host at a time. Stop a foreground host before starting the service.`);
    return;
  }
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
    console.log(packageMetadata.version);
    return;
  }
  const command = args[0] ?? 'serve';
  if (await backgroundCommand(command, args.slice(1))) return;
  const manager = createServiceManager();
  const directory =
    command === 'serve'
      ? path.resolve(process.env.SIM_RELAY_STATE_DIR ?? path.join(homedir(), '.sim-relay'))
      : await manager.selectedDirectory();
  if (command === 'permissions') {
    if (![2, 4].includes(args.length))
      throw new Error('Use permissions CLIENT_ID or permissions CLIENT_ID EXPECTED_REVISION JSON.');
    if (args.length === 2) {
      const clients = (await manager.admin({ action: 'list' })) as AuthorizedClient[];
      const client = clients.find((c) => c.id === args[1]);
      if (!client) throw new Error('This client is no longer authorized. Refresh the client list.');
      console.log(JSON.stringify(client, null, 2));
    } else {
      const expectedRevision = Number(args[2]);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
        throw new Error('Use the permission revision from permissions CLIENT_ID.');
      console.log(
        JSON.stringify(
          await manager.admin({
            action: 'permissions',
            id: args[1],
            expectedRevision,
            permissions: JSON.parse(args[3]),
          }),
          null,
          2,
        ),
      );
    }
    return;
  }
  if (args[0] === 'revoke' && args.length === 2) {
    await manager.admin({ action: 'revoke', id: args[1] });
    console.log('Client access revoked. Its active displays have been disconnected.');
    return;
  }
  if (args[0] === 'clients' && args.length === 1) {
    const clients = (await manager.admin({ action: 'list' })) as AuthorizedClient[];
    if (!clients.length)
      console.log('No authorized clients. Pair a client using the current code.');
    for (const client of clients)
      console.log(
        `${client.id}  ${client.name}\n  Paired: ${client.createdAt}\n  Last seen this host run: ${client.lastSeenAt ?? 'not connected'}\n  Active displays: ${client.activeSessions}`,
      );
    return;
  }
  if (args[0] === 'pairing' && args.length === 1) {
    const value = (await manager.admin({ action: 'pairing' })) as {
      token: string;
      fingerprint: string;
    };
    console.log(
      `Pairing code: ${value.token}\nSHA-256 fingerprint: ${value.fingerprint}\nThe code changes after each pairing. Share it only with the next client you want to authorize.`,
    );
    return;
  }
  if (args.length > 1) throw new Error('Run sim-relay-host --help for usage.');
  if (command !== 'serve') throw new Error('Unknown command. Run sim-relay-host --help for usage.');
  const port = Number(process.env.SIM_RELAY_PORT ?? 49300);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('SIM_RELAY_PORT must be between 1 and 65535.');
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
        void (async () => {
          try {
            await host.close();
            if (background) {
              await writeFile(
                serviceRetirementFile(directory, process.pid),
                JSON.stringify({ pid: process.pid, retired: true }),
                { mode: 0o600 },
              );
              await rm(ready, { force: true });
            }
            process.exit(0);
          } catch (error) {
            console.error(`Host cleanup failed: ${(error as Error).message}`);
            process.exit(1);
          }
        })();
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
