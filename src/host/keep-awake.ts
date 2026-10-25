import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { KeepAwakeStatus } from '../shared/host-management';

/** -i prevents idle system sleep; no -d assertion is made for the display.
 * -w ties the assertion to this host PID even if the host exits unexpectedly. */
export async function createKeepAwake(
  directory: string,
  dependencies: {
    platform?: string;
    initialEnabled?: boolean;
    start?: () => ChildProcess;
    memory?: () => { free: number; total: number };
  } = {},
) {
  const file = path.join(directory, 'keep-awake.json');
  let enabled = dependencies.initialEnabled ?? process.env.SIM_RELAY_KEEP_AWAKE === '1';
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value.version !== 1 || typeof value.enabled !== 'boolean')
      throw new Error('Cannot read keep-awake setting. Repair keep-awake.json before starting.');
    enabled = value.enabled;
    await chmod(file, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const supported = (dependencies.platform ?? process.platform) === 'darwin';
  let sessions = 0;
  let assertion: ChildProcess | undefined;
  let active = false;
  let failure: string | undefined;
  let closed = false;
  let retirement: Promise<void> = Promise.resolve();
  const release = () => {
    const child = assertion;
    assertion = undefined;
    active = false;
    if (!child) return;
    retirement = retirement.then(
      () =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once('exit', () => resolve());
          child.once('error', () => resolve());
          child.kill('SIGTERM');
        }),
    );
  };
  const update = () => {
    if (closed || !enabled || !sessions || !supported) return release();
    if (assertion) return;
    failure = undefined;
    const child = (
      dependencies.start ??
      (() => spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }))
    )();
    assertion = child;
    child.once('spawn', () => {
      if (assertion === child) active = true;
    });
    child.once('error', () => {
      if (assertion !== child) return;
      assertion = undefined;
      active = false;
      failure = 'Cannot prevent idle sleep. Check that /usr/bin/caffeinate is available.';
    });
    child.once('exit', () => {
      if (assertion !== child) return;
      assertion = undefined;
      active = false;
      failure = 'The keep-awake assertion ended. Turn the setting off and on to retry.';
    });
  };
  let saving = Promise.resolve();
  return {
    snapshot(): KeepAwakeStatus {
      const memory = (dependencies.memory ?? (() => ({ free: freemem(), total: totalmem() })))();
      return {
        enabled,
        active,
        activeSessions: sessions,
        supported,
        error: failure,
        warning:
          sessions > 1 && memory.free < Math.min(1024 ** 3, memory.total * 0.08)
            ? 'Available memory is low with multiple active simulators. Disconnect a display or shut down an unused simulator on the Mac.'
            : undefined,
      };
    },
    setEnabled(value: boolean): Promise<void> {
      const operation = saving.then(async () => {
        if (closed) throw new Error('The host is stopping.');
        if (typeof value !== 'boolean') throw new Error('Choose whether to prevent idle sleep.');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ version: 1, enabled: value }), { mode: 0o600 });
        await rename(temporary, file);
        enabled = value;
        update();
        await retirement;
      });
      saving = operation.catch(() => {});
      return operation;
    },
    sessionStarted() {
      if (closed) return () => {};
      sessions++;
      update();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        sessions--;
        update();
      };
    },
    async close() {
      closed = true;
      release();
      await saving;
      await retirement;
    },
  };
}
