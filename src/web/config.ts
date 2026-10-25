import path from 'node:path';
import { open } from 'node:fs/promises';
import type { WebOptions } from './server';

interface RuntimeConfig {
  users?: Record<string, string>;
  hosts?: string[];
  port?: number;
  bind?: string;
  origin?: string;
  cert?: string;
  key?: string;
}

/** Read secrets at startup, never from a package or a service definition. */
export async function webConfig(env: NodeJS.ProcessEnv): Promise<RuntimeConfig> {
  let config: RuntimeConfig = {};
  if (env.SIM_RELAY_WEB_CONFIG_FILE) {
    const file = env.SIM_RELAY_WEB_CONFIG_FILE;
    if (!path.isAbsolute(file))
      throw new Error('SIM_RELAY_WEB_CONFIG_FILE must be an absolute path.');
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024)
        throw new Error('The browser runtime file must be a regular JSON file smaller than 1 MB.');
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
        throw new Error(
          'The browser runtime file is readable by other users. Run chmod 600 on it.',
        );
      try {
        config = JSON.parse(await handle.readFile('utf8'));
      } catch {
        throw new Error(
          'The browser runtime file must contain valid JSON. Check its syntax and restart.',
        );
      }
    } finally {
      await handle.close();
    }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('The browser runtime file must contain a JSON object.');
  const known = ['users', 'hosts', 'port', 'bind', 'origin', 'cert', 'key'];
  if (Object.keys(config).some((key) => !known.includes(key)))
    throw new Error(
      'The browser runtime file has an unknown setting. Run sim-relay-web --help for supported settings.',
    );
  if (env.SIM_RELAY_WEB_USERS !== undefined) {
    try {
      config.users = JSON.parse(env.SIM_RELAY_WEB_USERS);
    } catch {
      throw new Error(
        'SIM_RELAY_WEB_USERS must contain a JSON mapping of user names to passwords.',
      );
    }
  }
  if (env.SIM_RELAY_WEB_HOSTS !== undefined)
    config.hosts = env.SIM_RELAY_WEB_HOSTS.split(',')
      .map((host) => host.trim())
      .filter(Boolean);
  for (const [key, variable] of Object.entries({
    bind: 'SIM_RELAY_WEB_BIND',
    origin: 'SIM_RELAY_WEB_ORIGIN',
    cert: 'SIM_RELAY_WEB_CERT',
    key: 'SIM_RELAY_WEB_KEY',
  })) {
    if (env[variable] !== undefined) (config as Record<string, unknown>)[key] = env[variable];
    const value = (config as Record<string, unknown>)[key];
    if (value !== undefined && (typeof value !== 'string' || !value))
      throw new Error(`Browser setting ${key} must be a nonempty string.`);
  }
  if (env.SIM_RELAY_WEB_PORT !== undefined) config.port = Number(env.SIM_RELAY_WEB_PORT);
  config.port ??= 49301;
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error('The browser port must be between 1 and 65535.');
  if (
    !config.users ||
    typeof config.users !== 'object' ||
    Array.isArray(config.users) ||
    Object.values(config.users).some((value) => typeof value !== 'string')
  )
    throw new Error('Configure users as a JSON mapping of user names to passwords.');
  if (!Array.isArray(config.hosts) || config.hosts.some((value) => typeof value !== 'string'))
    throw new Error('Configure hosts as an array of HTTPS Mac origins.');
  if (!!config.cert !== !!config.key)
    throw new Error('Set both the browser HTTPS certificate and private key paths.');
  if ([config.cert, config.key].some((value) => value && !path.isAbsolute(value)))
    throw new Error('Browser HTTPS certificate and private key paths must be absolute.');
  return config;
}

export function webOptions(config: RuntimeConfig, directory: string): Omit<WebOptions, 'tls'> {
  return {
    port: config.port,
    bind: config.bind,
    publicOrigin: config.origin,
    users: config.users!,
    allowedHosts: config.hosts!,
    directory,
  };
}
