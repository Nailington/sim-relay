import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm, open, chmod, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { HostStatus } from '../shared/types';

const run = promisify(execFile);
const label = 'dev.simrelay.host';
const agents = path.join(homedir(), 'Library/LaunchAgents');
const plist = path.join(agents, `${label}.plist`);
const log = path.join(homedir(), 'Library/Logs/Sim Relay/host.log');
const domain = `gui/${process.getuid?.()}`;
const target = `${domain}/${label}`;
const settingNames = [
  'SIM_RELAY_PORT',
  'SIM_RELAY_BIND',
  'SIM_RELAY_STATE_DIR',
  'IDB_COMPANION_PATH',
  'SIM_RELAY_ENABLE_HOST_AUDIO',
  'SIM_RELAY_AUDIO_HELPER',
] as const;
type Settings = Record<string, string>;
interface Agent {
  Label: string;
  EnvironmentVariables: Settings;
}

// A retiring process must never remove its replacement's readiness file during restart.
export const serviceStatusFile = (directory: string, pid: number) =>
  path.join(directory, `service-status-${pid}.json`);

export function printHostStatus(status: HostStatus) {
  console.log(
    `\nSim Relay host\n${status.url}\n${status.addresses?.join('\n')}\n\nPairing code: ${status.token}\nThe code changes after pairing. Run sim-relay-host pairing for the current code.\nSHA-256 fingerprint: ${status.fingerprint}\n\nXcode: ${status.info?.xcode ? 'ready' : 'not found'}\nInput service: ${status.info?.companion ? 'ready' : 'install idb_companion'}\n`,
  );
}

async function agent(): Promise<Agent | undefined> {
  try {
    await readFile(plist);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]);
  const value = JSON.parse(stdout) as Agent;
  if (value.Label !== label || !value.EnvironmentVariables?.SIM_RELAY_STATE_DIR)
    throw new Error(`Cannot read background host settings from ${plist}.`);
  return value;
}

async function job() {
  try {
    const { stdout } = await run('/bin/launchctl', ['print', target]);
    return { pid: Number(stdout.match(/^\s*pid = (\d+)$/m)?.[1]) || undefined };
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    if (/Could not find service|Could not find domain/i.test(failure.stderr ?? '')) return;
    throw error;
  }
}

async function ready(settings: Settings): Promise<HostStatus | undefined> {
  const current = await job();
  if (!current?.pid) return;
  try {
    const directory = settings.SIM_RELAY_STATE_DIR;
    const saved = JSON.parse(await readFile(serviceStatusFile(directory, current.pid), 'utf8')) as {
      pid: number;
      status: HostStatus;
    };
    if (saved.pid !== current.pid) return;
    return {
      ...saved.status,
      token: (await readFile(path.join(directory, 'token'), 'utf8')).trim(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
function configuration(settings: Settings) {
  const args = [process.execPath, ...process.execArgv, path.resolve(process.argv[1]), 'serve'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(process.argv[1].endsWith('.ts') ? process.cwd() : homedir())}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(settings)
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>15</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

async function stop() {
  if (await job()) await run('/bin/launchctl', ['bootout', target]);
  await rm(plist, { force: true });
}

function settingsFor(previous?: Agent): Settings {
  const settings: Settings = {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
    SIM_RELAY_STATE_DIR: path.join(homedir(), '.sim-relay'),
    SIM_RELAY_PORT: '49300',
    SIM_RELAY_BIND: '0.0.0.0',
    ...previous?.EnvironmentVariables,
    SIM_RELAY_BACKGROUND: '1',
  };
  for (const name of settingNames)
    if (process.env[name] !== undefined) settings[name] = process.env[name]!;
  settings.SIM_RELAY_STATE_DIR = path.resolve(settings.SIM_RELAY_STATE_DIR);
  if (settings.IDB_COMPANION_PATH)
    settings.IDB_COMPANION_PATH = path.resolve(settings.IDB_COMPANION_PATH);
  if (process.versions.electron) settings.ELECTRON_RUN_AS_NODE = '1';
  const port = Number(settings.SIM_RELAY_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('SIM_RELAY_PORT must be between 1 and 65535.');
  return settings;
}

async function start(settings: Settings) {
  const port = settings.SIM_RELAY_PORT;
  try {
    await run('/bin/launchctl', ['print', domain]);
  } catch {
    throw new Error(
      'Log into the macOS desktop first, then run sim-relay-host start again. Do not use sudo.',
    );
  }
  await mkdir(path.dirname(log), { recursive: true, mode: 0o700 });
  const output = await open(log, 'a', 0o600);
  await output.close();
  await chmod(log, 0o600);
  await writeFile(plist, configuration(settings), { mode: 0o600 });
  try {
    await run('/bin/launchctl', ['enable', target]);
    await run('/bin/launchctl', ['bootstrap', domain, plist]);
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await ready(settings);
      if (status) {
        console.log(
          'Background host started. You can close Terminal. It will start again at login.',
        );
        printHostStatus(status);
        console.log(`Logs: ${log}\nStop sharing: sim-relay-host stop`);
        return;
      }
      await delay(250);
    }
    throw new Error('The background host did not become ready.');
  } catch (error) {
    await stop();
    throw new Error(
      `${(error as Error).message}\nRun sim-relay-host logs for details. Check that another host is not already using port ${port}.`,
    );
  }
}

async function locked(action: () => Promise<void>) {
  await mkdir(agents, { recursive: true });
  const lockPath = `${plist}.lock`;
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lockPath, 'utf8'));
    let alive = true;
    try {
      if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 0);
      else alive = Date.now() - (await stat(lockPath)).mtimeMs < 60_000;
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code === 'EPERM';
    }
    if (alive) throw new Error('Another host command is running. Try again when it finishes.');
    await rm(lockPath, { force: true });
    lock = await open(lockPath, 'wx', 0o600);
  }
  try {
    await lock.writeFile(String(process.pid));
    await action();
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export async function backgroundCommand(command: string) {
  if (!['start', '--background', 'stop', 'restart', 'status', 'logs'].includes(command))
    return false;
  if (process.platform !== 'darwin' || !process.getuid?.())
    throw new Error(
      'Background hosting requires a logged-in Mac user. Run this command on the host Mac without sudo.',
    );
  if (command === 'logs') {
    try {
      const { stdout } = await run('/usr/bin/tail', ['-n', '50', log]);
      process.stdout.write(stdout);
    } catch (error) {
      if ((error as Error & { stderr?: string }).stderr?.includes('No such file'))
        console.log('No background host logs yet. Run sim-relay-host start first.');
      else throw error;
    }
  } else if (command === 'status') {
    const saved = await agent();
    const status = saved && (await ready(saved.EnvironmentVariables));
    if (status) {
      console.log('Background host is running.');
      printHostStatus(status);
    } else {
      console.log(
        (await job())
          ? 'Background host is registered but not ready. Run sim-relay-host logs for details.'
          : 'Background host is stopped. Run sim-relay-host start to share simulators.',
      );
      process.exitCode = 1;
    }
  } else {
    await locked(async () => {
      if (command === 'stop') {
        await stop();
        console.log('Background host stopped. It will not start at login.');
        return;
      }
      const saved = await agent();
      if (command === 'restart') {
        const settings = settingsFor(saved);
        await stop();
        await start(settings);
      } else if (await job()) {
        const status = saved && (await ready(saved.EnvironmentVariables));
        if (!status)
          throw new Error(
            'Background host is not ready. Run sim-relay-host logs or sim-relay-host restart.',
          );
        console.log('Background host is already running. Use restart to apply changed settings.');
        printHostStatus(status);
      } else await start(settingsFor(saved));
    });
  }
  return true;
}
