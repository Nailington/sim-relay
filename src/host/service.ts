import type { HostStatus } from '../shared/types';
import { createServiceManager } from './service-manager';
export { serviceStatusFile, serviceRetirementFile } from './service-manager';

/** Pairing codes are only printed by the explicit pairing command, never startup/logs/status. */
export function printHostStatus(status: HostStatus) {
  console.log(
    `\nSim Relay host\n${status.url}\n${status.addresses?.join('\n') ?? ''}\nVersion: ${status.info?.version ?? 'unknown'}\nSHA-256 fingerprint: ${status.fingerprint ?? 'unavailable'}\n\nXcode: ${status.info?.xcode ? 'ready' : 'not found'}\nInput service: ${status.info?.companion ? 'ready' : 'install idb_companion'}\nPairing: sim-relay-host pairing (current single-use code)\n`,
  );
}
export async function backgroundCommand(command: string, args: string[] = []) {
  if (
    ![
      'start',
      '--background',
      'stop',
      'restart',
      'status',
      'logs',
      'login',
      'settings',
      'configure',
      'keep-awake',
      'upgrade',
    ].includes(command)
  )
    return false;
  const manager = createServiceManager();
  if (command === 'upgrade') {
    if (args.length !== 1 || !['prepare', 'resume', 'abort'].includes(args[0]))
      throw new Error('Use sim-relay-host upgrade prepare|resume|abort.');
    await manager.upgrade(args[0] as 'prepare' | 'resume' | 'abort');
    console.log(
      args[0] === 'prepare'
        ? 'Host cleanup acknowledged. Upgrade the app, then run the newly installed sim-relay-host upgrade resume.'
        : args[0] === 'abort'
          ? 'Upgrade aborted. The host remains stopped. Verify the installation, then run sim-relay-host upgrade resume to recover the prior service.'
          : 'Upgrade handoff completed. Prior host configuration and login preference restored.',
    );
  } else if (command === 'login') {
    if (args.length !== 1 || !['on', 'off'].includes(args[0]))
      throw new Error('Use sim-relay-host login on|off.');
    await manager.setLogin(args[0] === 'on');
    console.log(
      `Start at login ${args[0] === 'on' ? 'enabled' : 'disabled'}. Current sharing is unchanged.`,
    );
  } else if (command === 'configure') {
    if (args.length !== 1)
      throw new Error(
        'Use sim-relay-host settings, then sim-relay-host configure JSON while stopped.',
      );
    await manager.saveSettings(JSON.parse(args[0]));
    console.log('Service settings saved. Run sim-relay-host start to share.');
  } else if (command === 'keep-awake') {
    if (args.length !== 1 || !['on', 'off'].includes(args[0]))
      throw new Error('Use sim-relay-host keep-awake on|off.');
    await manager.keepAwake(args[0] === 'on');
    console.log(
      `Preventing idle system sleep during active sessions ${args[0] === 'on' ? 'enabled' : 'disabled'}. Display sleep is unchanged.`,
    );
  } else {
    if (args.length) throw new Error('Run sim-relay-host --help for usage.');
    if (command === 'logs') process.stdout.write(await manager.logs());
    else if (command === 'settings')
      console.log(JSON.stringify((await manager.status()).settings, null, 2));
    else if (command === 'status') {
      const status = await manager.status();
      console.log(
        `${status.mode === 'foreground' ? 'Foreground host' : 'Background service'}: ${status.state}\nObserved: ${status.observedAt}\nState directory: ${status.settings.directory}\nStart at login: ${status.settings.startAtLogin ? 'on' : 'off'}`,
      );
      if (status.host) printHostStatus(status.host);
      if (status.keepAwake)
        console.log(
          `Prevent idle sleep: ${status.keepAwake.enabled ? 'on' : 'off'}; assertion ${status.keepAwake.active ? 'active' : 'inactive'}; active sessions: ${status.keepAwake.activeSessions}`,
        );
      if (status.message) console.log(status.message);
      if (status.state !== 'ready') process.exitCode = 1;
    } else {
      const status = await manager.action(
        command === '--background' ? 'start' : (command as 'start' | 'stop' | 'restart'),
      );
      console.log(
        command === 'stop'
          ? 'Background host stopped. Start at login is disabled. Saved service settings and authorizations are retained.'
          : `Background host is ${status.state}. It stays running when this app or Terminal closes. Start at login: ${status.settings.startAtLogin ? 'on' : 'off'}.`,
      );
      if (status.host) printHostStatus(status.host);
    }
  }
  return true;
}
