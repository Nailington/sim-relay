import { app, dialog } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, access, readFile, readlink } from 'node:fs/promises';
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
    // Keep the executable shim outside the app. Even a script's interpreter can
    // be suspended by macOS when the script is executed from a blocked .app path.
    const wrapper = `#!/bin/sh\n# Sim Relay host command\nexec /bin/sh ${shellQuote(launcher)} "$@"\n`;
    const existing = await lstat(command).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    let previousLink: string | undefined;
    if (existing) {
      if (
        existing.isSymbolicLink() &&
        (await realpath(command).catch(() => '')) === (await realpath(launcher))
      )
        previousLink = await readlink(command);
      else if (!existing.isFile() || (await readFile(command, 'utf8')) !== wrapper)
        throw new Error(
          `${command} already exists. Remove or rename it before installing this command. If Homebrew installed it, use brew upgrade instead.`,
        );
    }
    if (!existing || previousLink !== undefined) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: 'Install sim-relay-host?',
        detail: `Start sharing from Terminal with sim-relay-host. This installs a small launcher at ${command}. macOS will ask for an administrator password.`,
        buttons: ['Install command', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return;
      // Stage a complete wrapper first. An exclusive link preserves any unrelated
      // command created since the check; only our verified legacy symlink is removed.
      const replace =
        previousLink === undefined
          ? ''
          : `test -L ${shellQuote(command)} && test "$(/usr/bin/readlink ${shellQuote(command)})" = ${shellQuote(previousLink)} && /bin/rm ${shellQuote(command)}\n`;
      const script = `set -eu\n/bin/mkdir -p /usr/local/bin\nwork=$(/usr/bin/mktemp /usr/local/bin/.sim-relay-host.XXXXXXXX)\ntrap '/bin/rm -f "$work"' EXIT\nprintf '%s' ${shellQuote(wrapper)} > "$work"\n/bin/chmod 755 "$work"\n${replace}/bin/ln "$work" ${shellQuote(command)}`;
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
