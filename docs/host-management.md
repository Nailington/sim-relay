# Manage the Mac host

Open **Share this Mac** in the desktop workspace. Its controls manage the same persistent
background host as `sim-relay-host`, including a service originally started from Terminal.
Opening the panel attaches to local administration; it does not start another host.
The panel distinguishes background sharing, a foreground Terminal host, and stopped sharing.
Remote display connection status remains separate.

**Start background host** waits for the service to become ready. Closing the GUI leaves it
running. **Restart** waits for acknowledged cleanup before starting the saved instance.
**Stop host** also disables starting at login; it retains service settings, certificates,
and client authorization state. **Start background host when I log in** is an explicit,
independent preference. It does not start or stop the current service.

The status includes its observation time, readiness, current addresses, version, certificate
fingerprint, login preference, and active idle-sleep assertion. It refreshes every three
seconds while the panel is open. A registered service without a matching live local-admin
response is shown as not ready. Check `sim-relay-host logs` before restarting it. An occupied
port is a startup failure; Sim Relay does not replace the process using that port.

## Pairing and client access

Pairing codes are hidden by default. Reveal and copy retrieve the current single-use code
from the running host's local socket. Revealed codes refresh with status; copy always
fetches again at the moment of copying. Successful pairing rotates the code. Status,
startup output, logs, and diagnostic exports do not include the code. Older log files from
before this change may contain obsolete startup codes.

Use **Authorized clients** to list clients, active displays, and permission revisions.
**Revoke access…** asks for explicit confirmation, disconnects that client's displays, and
requires it to pair again. **Edit access** saves the full permission set using its observed
revision and disconnects the client's active displays. If another owner action changed the
revision, refresh and reopen the editor. The server remains the authority for every request.
The GUI does not introduce a network administration route: these actions use the existing
private Unix socket in the selected state directory.

## Saved settings and CLI

Use **Service settings** while the host is stopped to set an absolute state directory,
bind address, port, companion executable, optional audio helper, and explicit host-audio
opt-in. The state directory contains the certificate, client hashes, rotating pairing code,
and keep-awake setting. Changing it selects different authorization state; it does not
copy credentials. Audio remains off unless opted in, permitted for that client, and explicitly
started by the client.

Configuration is retained at `~/Library/Application Support/Sim Relay/host-service.json`.
Only host configuration is captured, never unrelated shell environment variables. An existing
CLI LaunchAgent is migrated with its saved instance, executable, bind/port, companion, audio,
and login settings intact. When login launch is enabled, the LaunchAgent is in
`~/Library/LaunchAgents/dev.simrelay.host.plist`; otherwise its running-job configuration is
stored outside LaunchAgents. Logs remain at `~/Library/Logs/Sim Relay/host.log`.

```sh
sim-relay-host start
sim-relay-host status
sim-relay-host pairing
sim-relay-host clients
sim-relay-host login on
sim-relay-host keep-awake on
sim-relay-host settings
sim-relay-host restart
sim-relay-host stop
```

`status` exits with 1 when stopped or not ready. `pairing`, `clients`, `revoke`, and
`permissions` select the background service's saved state directory. A conflicting explicit
`SIM_RELAY_STATE_DIR` is rejected with the saved directory; unset it or select that same
instance. On first setup, environment options initialize the saved configuration. Afterward,
use GUI settings or `sim-relay-host configure JSON` while stopped, using the complete object
printed by `settings`. Restart and stop/start preserve that configuration.

`sim-relay-host permissions CLIENT_ID` shows access and its revision. To replace it, use
`sim-relay-host permissions CLIENT_ID EXPECTED_REVISION JSON` with the complete permissions
object. New clients start with no device access until the owner grants it.

`sim-relay-host serve` runs in Terminal. Stop it there with Ctrl+C before starting the
background service. Do not run multiple hosts on the same state directory or port.

## Idle system sleep

**Prevent idle system sleep during active sessions** is opt-in and persists per state
directory. The host uses `/usr/bin/caffeinate -i -w HOST_PID` only after a simulator session
starts. It releases the assertion when the last session ends, the setting is disabled,
sharing stops, or the host exits. The assertion does not request display wakefulness.
Closing the GUI does not change the separately running host's setting.

Preventing idle sleep uses more power. Explicit sleep, shutdown, and lid behavior remain
subject to macOS and hardware policy; this does not promise lid-closed operation. The panel
shows assertion errors and a basic low-available-memory warning with multiple active sessions.
That warning is an estimate, not a measurement of macOS memory pressure.

## App replacement and upgrade handoff

The host lifecycle commands used by the coordinated installer are:

```sh
sim-relay-host upgrade prepare
# Replace the application only after prepare exits with 0.
# Invoke resume using the newly installed application's bundled launcher.
sim-relay-host upgrade resume
```

`prepare` captures the owned background host's saved settings, prior-running state, and login
preference in the private, secret-free `host-upgrade.json` beside the saved service settings.
It suspends login launch, stops the job, waits for the process to exit, and requires a
retirement acknowledgment written only after awaited listener/session/media cleanup succeeds.
Launchd force termination or missing cleanup acknowledgment causes a nonzero exit; do not
replace the app. A second prepare and ordinary service mutations are blocked while the
handoff exists. Older hosts that cannot provide this acknowledgment require manual inspection
and a stopped-host upgrade; they cannot use automatic graceful handoff.

`resume` uses the newly invoked executable, retains instance configuration and authorization,
and restarts only a host that was previously running. It verifies readiness against the
local admin PID. A stopped host stays stopped, with its login preference restored.

If installation fails, `sim-relay-host upgrade abort` retains the recovery record and leaves
the host stopped. After verifying or repairing the installed app, explicitly run
`sim-relay-host upgrade resume`. Aborting does not automatically restart anything. If shutdown
was not acknowledged, inspect the logs first; the wrapper must not proceed with replacement.

## Validation boundary

Private Linux regressions exercise service configuration migration, ownership/refusal,
rotating-code retrieval, login retention, graceful-handoff failure/recovery, and the injected
keep-awake lifecycle. Renderer checks use mocked local service responses. These checks do
not establish native launchd, login/logout, caffeinate power behavior, real simulator capture,
Homebrew replacement, audio permissions, or physical sleep/wake behavior. Those still require
an actual Mac acceptance run before closing the corresponding issues.
