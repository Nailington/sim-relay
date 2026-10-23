import { app, dialog } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, access } from 'node:fs/promises';
import path from 'node:path';

const command = '/usr/local/bin/sim-relay-host';
const run = promisify(execFile);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function installHostCommand() {
  try {
    if (!app.isPackaged || !app.isInApplicationsFolder()) {
      dialog.showErrorBox(
        'Move Sim Relay to Applications first',
        'Drag Sim Relay into Applications, open it there, and choose Install host command again.',
      );
      return;
    }
    const launcher = path.join(process.resourcesPath, 'bin/sim-relay-host');
    await access(launcher);
    const existing = await lstat(command).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (existing) {
      if ((await realpath(command).catch(() => '')) !== (await realpath(launcher)))
        throw new Error(
          `${command} already exists. Remove or rename it before installing this command. If Homebrew installed it, use brew upgrade instead.`,
        );
    } else {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: 'Install sim-relay-host?',
        detail: `Start sharing from Terminal with sim-relay-host. This installs a link at ${command}. macOS will ask for an administrator password.`,
        buttons: ['Install command', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return;
      // ln without -f preserves any command created since the check above.
      const script = `/bin/mkdir -p /usr/local/bin && /bin/ln -s ${shellQuote(launcher)} ${shellQuote(command)}`;
      await run('/usr/bin/osascript', [
        '-e',
        `do shell script ${JSON.stringify(script)} with administrator privileges`,
      ]);
    }
    await dialog.showMessageBox({
      type: 'info',
      message: 'Host command installed',
      detail:
        'Open a new Terminal window and run sim-relay-host. Keep Sim Relay in Applications so the command stays available.',
      buttons: ['Done'],
    });
  } catch (error) {
    dialog.showErrorBox('Cannot install host command', (error as Error).message);
  }
}
