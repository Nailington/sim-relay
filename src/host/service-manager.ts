import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, rm, open, chmod, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { clientAdminRequest } from './client-admin';
import { createKeepAwake } from './keep-awake';
import type { HostStatus } from '../shared/types';
import type {
  HostManagementStatus,
  HostServiceSettings,
  KeepAwakeStatus,
} from '../shared/host-management';

const run = promisify(execFile);
const label = 'dev.simrelay.host';
const names = [
  'SIM_RELAY_PORT',
  'SIM_RELAY_BIND',
  'SIM_RELAY_STATE_DIR',
  'IDB_COMPANION_PATH',
  'SIM_RELAY_ENABLE_HOST_AUDIO',
  'SIM_RELAY_AUDIO_HELPER',
  'SIM_RELAY_KEEP_AWAKE',
] as const;
export interface ServiceLaunch {
  args: string[];
  workingDirectory: string;
}
interface Configuration {
  version: 1;
  environment: Record<string, string>;
  launch: ServiceLaunch;
  startAtLogin: boolean;
}
interface Agent {
  Label: string;
  EnvironmentVariables: Record<string, string>;
  ProgramArguments: string[];
  WorkingDirectory?: string;
}
interface LocalStatus extends Omit<HostStatus, 'token'> {
  pid: number;
  mode: 'background' | 'foreground';
  keepAwake?: KeepAwakeStatus;
}
interface Upgrade {
  version: 1;
  phase: 'preparing' | 'prepared' | 'aborted';
  priorRunning: boolean;
  pid?: number;
  configuration: Configuration;
}
const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
export const serviceStatusFile = (directory: string, pid: number) =>
  path.join(directory, `service-status-${pid}.json`);
export const serviceRetirementFile = (directory: string, pid: number) =>
  path.join(directory, `service-retired-${pid}.json`);
export function cliServiceLaunch(): ServiceLaunch {
  return {
    args: [process.execPath, ...process.execArgv, path.resolve(process.argv[1]), 'serve'],
    workingDirectory: process.argv[1].endsWith('.ts') ? process.cwd() : homedir(),
  };
}
export function createServiceManager(
  dependencies: {
    home?: string;
    platform?: string;
    uid?: number;
    launch?: ServiceLaunch;
    environment?: NodeJS.ProcessEnv;
    run?: (file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>;
    request?: (directory: string, value: unknown) => Promise<unknown>;
    alive?: (pid: number) => boolean;
    wait?: (ms: number) => Promise<unknown>;
  } = {},
) {
  const home = dependencies.home ?? homedir();
  const control = path.join(home, 'Library/Application Support/Sim Relay');
  const agents = path.join(home, 'Library/LaunchAgents');
  const loginPlist = path.join(agents, `${label}.plist`);
  const privatePlist = path.join(control, 'host-service.plist');
  const savedFile = path.join(control, 'host-service.json');
  const upgradeFile = path.join(control, 'host-upgrade.json');
  const log = path.join(home, 'Library/Logs/Sim Relay/host.log');
  const uid = dependencies.uid ?? process.getuid?.();
  const domain = `gui/${uid}`,
    target = `${domain}/${label}`;
  const execute = dependencies.run ?? (async (file, args) => run(file, args));
  const request = dependencies.request ?? clientAdminRequest;
  const wait = dependencies.wait ?? delay;
  const environment = dependencies.environment ?? process.env;
  const alive =
    dependencies.alive ??
    ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    });
  let starting = false;
  const requireMac = () => {
    if ((dependencies.platform ?? process.platform) !== 'darwin' || !uid)
      throw new Error(
        'Background hosting requires a logged-in Mac user. Run on the host Mac without sudo.',
      );
  };
  async function readJson<T>(filename: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(filename, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  async function save(filename: string, value: unknown) {
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, filename);
    await chmod(filename, 0o600);
  }
  async function configuration(): Promise<Configuration> {
    const saved = await readJson<Configuration>(savedFile);
    if (saved) {
      if (
        saved.version !== 1 ||
        !saved.environment ||
        !saved.launch?.args?.length ||
        typeof saved.startAtLogin !== 'boolean'
      )
        throw new Error(`Cannot read saved background host settings: ${savedFile}`);
      return saved;
    }
    let previous: Agent | undefined;
    try {
      await readFile(loginPlist);
      previous = JSON.parse(
        (await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', loginPlist])).stdout,
      );
      if (
        previous?.Label !== label ||
        !previous.EnvironmentVariables?.SIM_RELAY_STATE_DIR ||
        !previous.ProgramArguments?.length
      )
        throw new Error(`Cannot read background host settings from ${loginPlist}.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const env: Record<string, string> = {
      PATH:
        previous?.EnvironmentVariables.PATH ??
        environment.PATH ??
        '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
      SIM_RELAY_STATE_DIR: path.join(home, '.sim-relay'),
      SIM_RELAY_PORT: '49300',
      SIM_RELAY_BIND: '0.0.0.0',
      SIM_RELAY_BACKGROUND: '1',
    };
    // Only host settings are persisted. Never capture a shell's unrelated credentials.
    for (const name of names) {
      const value = previous?.EnvironmentVariables[name] ?? environment[name];
      if (value !== undefined) env[name] = value;
    }
    if (process.versions.electron || previous?.EnvironmentVariables.ELECTRON_RUN_AS_NODE === '1')
      env.ELECTRON_RUN_AS_NODE = '1';
    env.SIM_RELAY_STATE_DIR = path.resolve(env.SIM_RELAY_STATE_DIR);
    return {
      version: 1,
      environment: env,
      startAtLogin: !!previous,
      launch: previous
        ? { args: previous.ProgramArguments, workingDirectory: previous.WorkingDirectory ?? home }
        : (dependencies.launch ?? cliServiceLaunch()),
    };
  }
  function settings(config: Configuration): HostServiceSettings {
    const env = config.environment;
    const port = Number(env.SIM_RELAY_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(
        'Saved service port must be between 1 and 65535. Stop the host and correct its service settings.',
      );
    return {
      directory: env.SIM_RELAY_STATE_DIR,
      port,
      bind: env.SIM_RELAY_BIND,
      companionPath: env.IDB_COMPANION_PATH ?? '',
      hostAudio: env.SIM_RELAY_ENABLE_HOST_AUDIO === '1',
      audioHelper: env.SIM_RELAY_AUDIO_HELPER ?? '',
      startAtLogin: config.startAtLogin,
    };
  }
  function selected(config: Configuration) {
    if (
      environment.SIM_RELAY_STATE_DIR &&
      path.resolve(environment.SIM_RELAY_STATE_DIR) !== config.environment.SIM_RELAY_STATE_DIR
    )
      throw new Error(
        `The background service uses ${config.environment.SIM_RELAY_STATE_DIR}. Unset SIM_RELAY_STATE_DIR to manage it, or select that same directory.`,
      );
  }
  async function job(): Promise<{ pid?: number } | undefined> {
    try {
      const { stdout } = await execute('/bin/launchctl', ['print', target]);
      return { pid: Number(stdout.match(/^\s*pid = (\d+)$/m)?.[1]) || undefined };
    } catch (error) {
      if (
        /Could not find service|Could not find domain/i.test(
          (error as { stderr?: string }).stderr ?? '',
        )
      )
        return;
      throw error;
    }
  }
  async function local(config: Configuration): Promise<LocalStatus | undefined> {
    try {
      return (await request(config.environment.SIM_RELAY_STATE_DIR, {
        action: 'status',
      })) as LocalStatus;
    } catch {
      return;
    }
  }
  async function status(): Promise<HostManagementStatus> {
    requireMac();
    const config = await configuration();
    selected(config);
    const current = await job();
    const observed = await local(config);
    const matching = observed?.running && (!current?.pid || observed.pid === current.pid);
    let host: Omit<HostStatus, 'token'> | undefined;
    if (matching) {
      // Explicit projection keeps pairing codes out of status and diagnostics even with an older peer.
      host = {
        running: true,
        url: observed.url,
        addresses: observed.addresses,
        fingerprint: observed.fingerprint,
        info: observed.info,
      };
    }
    let keepAwake = matching ? observed.keepAwake : undefined;
    if (!keepAwake && !current) {
      const policy = await createKeepAwake(config.environment.SIM_RELAY_STATE_DIR, {
        platform: dependencies.platform,
        initialEnabled: config.environment.SIM_RELAY_KEEP_AWAKE === '1',
      });
      keepAwake = policy.snapshot();
      await policy.close();
    }
    return {
      state: starting ? 'starting' : matching ? 'ready' : current ? 'unhealthy' : 'stopped',
      mode: matching ? observed.mode : current ? 'background' : 'none',
      observedAt: new Date().toISOString(),
      registered: !!current,
      pid: matching ? observed.pid : current?.pid,
      settings: settings(config),
      host,
      keepAwake,
      message: (await readJson(upgradeFile))
        ? 'A host upgrade handoff is pending. Complete installation and run sim-relay-host upgrade resume; login launch is suspended until recovery.'
        : current && !matching
          ? 'The service is registered but is not ready. Refresh, restart the host, or run sim-relay-host logs on this Mac.'
          : undefined,
    };
  }
  function plist(config: Configuration) {
    const env = Object.entries(config.environment)
      .map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`)
      .join('');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${config.launch.args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(config.launch.workingDirectory)}</string>
<key>EnvironmentVariables</key><dict>${env}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>30</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n`;
  }
  async function writePlist(config: Configuration) {
    await mkdir(control, { recursive: true, mode: 0o700 });
    await mkdir(agents, { recursive: true });
    const filename = config.startAtLogin ? loginPlist : privatePlist;
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, plist(config), { mode: 0o600 });
    await rename(temporary, filename);
    await chmod(filename, 0o600);
    await rm(config.startAtLogin ? privatePlist : loginPlist, { force: true });
    return filename;
  }
  async function locked<T>(action: () => Promise<T>): Promise<T> {
    requireMac();
    await mkdir(control, { recursive: true, mode: 0o700 });
    const filename = path.join(control, 'host-service.lock');
    let lock;
    try {
      lock = await open(filename, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(filename, 'utf8'));
      if (
        Number.isSafeInteger(pid) && pid > 0
          ? alive(pid)
          : Date.now() - (await stat(filename)).mtimeMs < 60000
      )
        throw new Error('Another host command is running. Try again when it finishes.');
      await rm(filename, { force: true });
      lock = await open(filename, 'wx', 0o600);
    }
    try {
      await lock.writeFile(String(process.pid));
      return await action();
    } finally {
      await lock.close();
      await rm(filename, { force: true });
    }
  }
  async function noUpgrade() {
    if (await readJson(upgradeFile))
      throw new Error(
        'A host upgrade is pending. Complete installation and run sim-relay-host upgrade resume, or run sim-relay-host upgrade abort.',
      );
  }
  async function start(config: Configuration) {
    const current = await job();
    if (current) {
      const observed = await status();
      if (observed.state === 'ready') return observed;
      throw new Error(
        'The registered background host is not ready. Run sim-relay-host logs or restart it.',
      );
    }
    const existing = await local(config);
    if (existing?.running)
      throw new Error(
        'A foreground host already uses this state directory. Stop it in its Terminal before starting the background host.',
      );
    try {
      await execute('/bin/launchctl', ['print', domain]);
    } catch {
      throw new Error('Log into the macOS desktop first. Run on the host Mac without sudo.');
    }
    await mkdir(path.dirname(log), { recursive: true, mode: 0o700 });
    const output = await open(log, 'a', 0o600);
    await output.close();
    await chmod(log, 0o600);
    await save(savedFile, config);
    const filename = await writePlist(config);
    starting = true;
    try {
      await execute('/bin/launchctl', ['enable', target]);
      await execute('/bin/launchctl', ['bootstrap', domain, filename]);
      const deadline = Date.now() + 25_000;
      for (let attempt = 0; attempt < 100 && Date.now() < deadline; attempt++) {
        const j = await job(),
          observed = await local(config);
        if (
          j?.pid &&
          observed?.running &&
          observed.pid === j.pid &&
          observed.mode === 'background'
        ) {
          starting = false;
          return status();
        }
        await wait(250);
      }
      throw new Error(
        `The background host did not become ready. Check sim-relay-host logs and whether port ${config.environment.SIM_RELAY_PORT} is occupied. No other host was replaced.`,
      );
    } catch (error) {
      // Refuse to kill an unrelated listener. Only retire our own launchd job.
      try {
        await retire(config, false);
      } catch {
        /* The original startup failure remains actionable. */
      }
      throw error;
    } finally {
      starting = false;
    }
  }
  async function retire(config: Configuration, requireAck: boolean) {
    const current = await job();
    if (!current) return;
    const pid = current.pid;
    if (pid && requireAck) {
      const observed = await local(config);
      if (!observed?.running || observed.pid !== pid || observed.mode !== 'background')
        throw new Error(
          'Cannot verify ownership/readiness of the background host. Resolve its status before upgrading.',
        );
    }
    if (pid)
      await rm(serviceRetirementFile(config.environment.SIM_RELAY_STATE_DIR, pid), { force: true });
    await execute('/bin/launchctl', ['bootout', target]);
    for (let attempt = 0; pid && alive(pid) && attempt < 160; attempt++) await wait(250);
    if (pid && alive(pid))
      throw new Error(
        'The background host is still stopping. Do not replace the app. Check its logs.',
      );
    if (pid && requireAck) {
      const ack = await readJson<{ pid: number; retired: true }>(
        serviceRetirementFile(config.environment.SIM_RELAY_STATE_DIR, pid),
      );
      if (ack?.pid !== pid || ack.retired !== true)
        throw new Error(
          'The host did not acknowledge complete cleanup. Installation was not authorized. Inspect host logs before recovery.',
        );
    }
  }
  async function updateSettings(value: HostServiceSettings) {
    const config = await configuration();
    selected(config);
    if ((await job()) || (await local(config))?.running)
      throw new Error('Stop the host before changing its service settings.');
    if (
      !value ||
      !path.isAbsolute(value.directory) ||
      !value.directory.trim() ||
      !Number.isInteger(value.port) ||
      value.port < 1 ||
      value.port > 65535 ||
      typeof value.bind !== 'string' ||
      !value.bind.trim() ||
      value.bind.length > 255 ||
      typeof value.startAtLogin !== 'boolean' ||
      typeof value.hostAudio !== 'boolean' ||
      ![value.directory, value.companionPath, value.audioHelper].every(
        (p) => typeof p === 'string' && p.length < 4096 && !/[\x00-\x1f]/.test(p),
      ) ||
      [value.companionPath, value.audioHelper].some((p) => p && !path.isAbsolute(p))
    )
      throw new Error(
        'Use an absolute state directory and executable paths, a bind address, and a port between 1 and 65535.',
      );
    Object.assign(config.environment, {
      SIM_RELAY_STATE_DIR: path.resolve(value.directory),
      SIM_RELAY_PORT: String(value.port),
      SIM_RELAY_BIND: value.bind.trim(),
      IDB_COMPANION_PATH: value.companionPath,
      SIM_RELAY_ENABLE_HOST_AUDIO: value.hostAudio ? '1' : '0',
      SIM_RELAY_AUDIO_HELPER: value.audioHelper,
    });
    config.startAtLogin = value.startAtLogin;
    await save(savedFile, config);
    await writePlist(config);
    return status();
  }
  return {
    status,
    async selectedDirectory() {
      const config = await configuration();
      selected(config);
      return config.environment.SIM_RELAY_STATE_DIR;
    },
    action(action: 'start' | 'stop' | 'restart') {
      return locked(async () => {
        await noUpgrade();
        const config = await configuration();
        selected(config);
        if (action === 'start') return start(config);
        await retire(config, action === 'restart');
        if (action === 'restart') return start(config);
        config.startAtLogin = false;
        await save(savedFile, config);
        await writePlist(config);
        return status();
      });
    },
    saveSettings(value: HostServiceSettings) {
      return locked(async () => {
        await noUpgrade();
        return updateSettings(value);
      });
    },
    setLogin(enabled: boolean) {
      return locked(async () => {
        await noUpgrade();
        if (typeof enabled !== 'boolean') throw new Error('Choose whether to start at login.');
        const config = await configuration();
        selected(config);
        config.startAtLogin = enabled;
        await save(savedFile, config);
        await writePlist(config);
        return status();
      });
    },
    keepAwake(enabled: boolean) {
      return locked(async () => {
        await noUpgrade();
        const config = await configuration();
        selected(config);
        const observed = await local(config);
        if (observed?.running)
          return request(config.environment.SIM_RELAY_STATE_DIR, { action: 'keep-awake', enabled });
        if (await job())
          throw new Error('The host is not ready. Restart it before changing keep-awake.');
        const policy = await createKeepAwake(config.environment.SIM_RELAY_STATE_DIR);
        try {
          await policy.setEnabled(enabled);
          return policy.snapshot();
        } finally {
          await policy.close();
        }
      });
    },
    async pairing() {
      const config = await configuration();
      selected(config);
      return request(config.environment.SIM_RELAY_STATE_DIR, { action: 'pairing' }) as Promise<{
        token: string;
        fingerprint: string;
      }>;
    },
    async admin(value: unknown) {
      const config = await configuration();
      selected(config);
      return request(config.environment.SIM_RELAY_STATE_DIR, value);
    },
    async logs() {
      requireMac();
      return (await execute('/usr/bin/tail', ['-n', '50', log])).stdout;
    },
    upgrade(phase: 'prepare' | 'resume' | 'abort') {
      return locked(async () => {
        const existing = await readJson<Upgrade>(upgradeFile);
        if (phase === 'prepare') {
          if (existing)
            throw new Error(
              'An upgrade handoff already exists. Resume or abort it before preparing another upgrade.',
            );
          const config = await configuration();
          selected(config);
          const current = await job();
          if (current?.pid) {
            const observed = await local(config);
            if (observed?.pid !== current.pid || observed.mode !== 'background')
              throw new Error('Cannot verify the running background host. Do not replace the app.');
          }
          if (!current && (await local(config))?.running)
            throw new Error('Stop the foreground host before upgrading the app.');
          const handoff: Upgrade = {
            version: 1,
            phase: 'preparing',
            priorRunning: !!current?.pid,
            pid: current?.pid,
            configuration: config,
          };
          await save(upgradeFile, handoff);
          // Disable next-login launch before replacing any files. Preserve the desired value in the handoff.
          await rm(loginPlist, { force: true });
          await retire(config, true);
          handoff.phase = 'prepared';
          await save(upgradeFile, handoff);
          return;
        }
        if (!existing || existing.version !== 1)
          throw new Error('No recoverable host upgrade handoff exists.');
        selected(existing.configuration);
        if (phase === 'abort') {
          if (await job())
            throw new Error(
              'The host is still registered. Resolve its shutdown before aborting the upgrade.',
            );
          existing.phase = 'aborted';
          await save(upgradeFile, existing);
          return;
        }
        if (existing.phase === 'preparing')
          throw new Error(
            'Shutdown was not acknowledged. Inspect the host logs, then use upgrade abort before manual recovery.',
          );
        if (await job())
          throw new Error(
            'A service was started during the upgrade. Stop it before resuming this handoff.',
          );
        const config = {
          ...existing.configuration,
          launch: dependencies.launch ?? cliServiceLaunch(),
        };
        // Refresh runtime paths after app replacement without changing pairing, bind, audio, or login settings.
        if (process.versions.electron) config.environment.ELECTRON_RUN_AS_NODE = '1';
        await save(savedFile, config);
        if (existing.priorRunning) {
          try {
            await start(config);
          } catch (error) {
            await rm(loginPlist, { force: true });
            throw error;
          }
        } else await writePlist(config);
        await rm(upgradeFile, { force: true });
      });
    },
  };
}
