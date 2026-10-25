# Host browser workspaces

The browser service runs on Linux or macOS and reaches explicitly configured Mac hosts.
Simulator capture and control still run on Macs with Xcode and idb_companion. The installed
command includes its server and frontend; no source checkout, npm, or system Node is needed.

## Install and configure

New macOS DMG/ZIP releases include
`/Applications/Sim Relay.app/Contents/Resources/bin/sim-relay-web`; the Homebrew cask also
links `sim-relay-web` on PATH. Linux tar.gz, DEB and RPM releases include
`resources/bin/sim-relay-web` beside the installed app runtime. For a Linux tar deployment,
extract the release to `/opt/sim-relay` and use
`/opt/sim-relay/resources/bin/sim-relay-web`. DEB/RPM install below `/opt/Sim Relay`;
use `/opt/Sim Relay/resources/bin/sim-relay-web`. AppImage users must extract with
`--appimage-extract` and use `squashfs-root/resources/bin/sim-relay-web` (keep the whole
extracted tree). Windows installers provide the desktop client, not this web command.
Existing releases before this feature do not contain it.

Nix exposes `packages.<system>.sim-relay-web` and `apps.<system>.sim-relay-web`:

```sh
nix profile install github:Nailington/sim-relay#sim-relay-web
sim-relay-web --help
```

The main Nix desktop package also includes the command. The dedicated web package uses
Node 24 from Nix and needs no Electron/display server. Release packages reuse their bundled
Electron runtime in Node mode. Assets resolve relative to the installed server, so any
working directory works. Keep the complete installation together.

Create `~/.config/sim-relay/web.json` privately, with mode 600 and a parent directory with
mode 700. Supply real, unique passwords of at least 16 characters:

```json
{
  "users": { "alice": "<unique password of at least 16 characters>" },
  "hosts": ["https://studio-mac.local:49300"],
  "bind": "127.0.0.1",
  "port": 49301,
  "origin": "https://sim-relay.example.com"
}
```

```sh
SIM_RELAY_WEB_CONFIG_FILE="$HOME/.config/sim-relay/web.json" sim-relay-web serve
```

The service refuses group/world-readable runtime files on Unix. Do not put passwords in
command arguments, service definitions, Nix expressions, or version control. The JSON
file supports `users`, `hosts`, `bind`, `port`, `origin`, `cert`, and `key`; unknown keys
are rejected. `cert` and `key` must both be absolute paths. Environment variables override
matching file settings: `SIM_RELAY_WEB_USERS` (JSON object), `SIM_RELAY_WEB_HOSTS`
(comma-separated origins), `SIM_RELAY_WEB_BIND`, `SIM_RELAY_WEB_PORT`,
`SIM_RELAY_WEB_ORIGIN`, `SIM_RELAY_WEB_CERT`, and `SIM_RELAY_WEB_KEY`.
An existing private environment-file deployment remains supported. No settings or secrets
are written back to the installation. Restart after editing configuration.

For local use, omit `origin`; the default URL is `http://127.0.0.1:49301`.
The service requires configured users and an explicit allowlist of HTTPS Mac host origins.
Add every address clients will enter, including SSH-tunnel addresses if used. This list
limits the endpoints the relay can probe. Each Mac independently authorizes browser clients.

Saved Macs can have multiple [verified addresses](mac-addresses.md). Allow every
preferred and fallback address in the runtime hosts list or `SIM_RELAY_WEB_HOSTS`.
The relay rejects an entire routing set containing a disallowed origin before probing
or forwarding credentials; client-supplied fallback routes cannot extend this allowlist.

For direct HTTPS, set `cert` and `key` to the browser certificate and private key paths,
`bind` to `0.0.0.0`, and `origin` to `https://your-server-name:49301`. Browsers must trust
this certificate, which is separate from each Mac's pinned certificate. Protect key files
so only the service user can read them. Remote plain-HTTP origins are rejected.

For a reverse proxy, keep `bind` on loopback and set `origin` to the public HTTPS origin.
Terminate TLS at the proxy, preserve the public `Host` header, forward all HTTP routes,
and enable WebSocket upgrade for `/api/stream`. Permit request bodies of at least 128 MB,
stream downloads without response buffering, and allow requests longer than two minutes.
Restrict the relay port so clients cannot bypass the proxy. The service retains `Host`
and `Origin` checks and HttpOnly, SameSite=Strict cookies (Secure for public HTTPS).

## Managed services

Linux releases include `resources/services/sim-relay-web.service`. Copy it to
`~/.config/systemd/user/sim-relay-web.service`; adjust `ExecStart` to the absolute installed
command path (quote a path containing spaces). It references the private JSON file, not
passwords. Then run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now sim-relay-web
systemctl --user restart sim-relay-web
systemctl --user status sim-relay-web
journalctl --user -u sim-relay-web -f
# Stop and disable automatic startup:
systemctl --user disable --now sim-relay-web
```

User services start with the user's session. For an always-on machine, an administrator
can enable user lingering with `loginctl enable-linger USER`, or use the NixOS system
service below. Neither web process needs to run as root.

macOS releases include `Contents/Resources/services/dev.simrelay.web.plist`. Copy it to
`~/Library/LaunchAgents/dev.simrelay.web.plist`, replacing every `@HOME@` with the absolute
home path (XML-escape characters such as `&`). Create `~/Library/Logs/Sim Relay` privately,
set the plist to mode 600, and keep the default stable `/Applications` launcher path.
Run as the logged-in user without sudo:

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.simrelay.web.plist"
launchctl kickstart -k "gui/$(id -u)/dev.simrelay.web" # restart
launchctl print "gui/$(id -u)/dev.simrelay.web"        # status
tail -f "$HOME/Library/Logs/Sim Relay/web.log"
# Stop; remove the plist as well to disable startup at login:
launchctl bootout "gui/$(id -u)/dev.simrelay.web"
```

A manager reporting a running process is not a readiness probe. Open the configured origin
and check its sign-in page; inspect logs when startup fails. Normal manager stops send
SIGTERM; the server closes browser streams, relay requests and its listener before exiting.
A restart invalidates all sign-ins and live relay sessions. Sign in again to use browser-local
pairings. Remove/change a user in the runtime file and restart to revoke that deployment
login; `sim-relay-host revoke CLIENT_ID` separately revokes access to a Mac.

Before replacing a release installation, stop this web service and wait for it to exit.
After replacement, start it from the stable installed path and verify the sign-in page.
If installation fails, leave it stopped, repair the package, then start it explicitly.
The Homebrew host-upgrade wrapper manages the Mac host only: stop/restart the web launch
agent separately. NixOS switches use systemd's service restart on changed package paths.

## NixOS service and runtime secrets

Import `inputs.sim-relay.nixosModules.sim-relay-web`, then configure:

```nix
services.sim-relay-web = {
  enable = true;
  package = inputs.sim-relay.packages.${pkgs.stdenv.hostPlatform.system}.sim-relay-web;
  runtimeConfigFile = "/run/secrets/sim-relay-web.json";
  publicOrigin = "https://sim-relay.example.com";
  allowedHosts = [ "https://studio-mac.local:49300" ];
};
```

Provision that file at runtime through your secret manager (or a root-owned mode-600 file),
containing `users` and optionally `hosts`, `origin`, `bind`, `port`, `cert`, and `key`.
`runtimeConfigFile` is a **string path**, never a Nix path literal, `builtins.toFile`, or
`pkgs.writeText`. The module rejects `/nix/store` paths. systemd `LoadCredential` copies
its contents into the service's private credentials directory. The derivation and unit
contain only the filename. Do not import the secret contents during Nix evaluation.
The module runs with a dynamic unprivileged user, read-only system/home protections,
a private temp directory, and no writable application state.

Module `bind` and `port` override the file (defaults `127.0.0.1` and `49301`);
`publicOrigin` and a nonempty `allowedHosts` override file values when configured.
For direct HTTPS, use runtime string paths `tlsCertificateFile` and `tlsKeyFile`; both are
loaded as private systemd credentials and override JSON TLS paths. This works with
`ProtectHome` and avoids giving the dynamic user access to the original private key.
Use an HTTPS reverse proxy for privileged port 443; this module does not open a firewall.

```sh
systemctl restart sim-relay-web
systemctl status sim-relay-web
journalctl -u sim-relay-web -f
```

## Pair and use a Mac

1. Sign in using an account configured by the deployment owner.
2. Add the Mac's allowlisted HTTPS address. Discovery is unavailable through the relay.
3. Compare its fingerprint with the Mac and enter the current single-use pairing code.
4. Select or create a simulator, boot it when needed, and connect the display.

The Node relay verifies the pinned Mac certificate for authenticated requests and WSS
streams. The browser never disables TLS validation to talk directly to a self-signed Mac.
Pairing credentials pass through the hosting machine in memory, so its operator must be
trusted. Never host third-party scripts at the same origin.

Each tab has its own live stream, retry lifecycle, media controls, and input routing.
Two tabs/browsers can control different simulators; connecting to the same simulator reports
the host's controlling-client conflict. Closing a tab releases its connection. Signing out
closes connections that share that sign-in cookie; other browser profiles and independent
sign-ins keep their streams. A simulator itself is shared state, not a clone per browser.
Hidden tabs disconnect to release input; reconnect when returning to the tab.

Network interruptions retry the original Mac and simulator with bounded backoff. Cancel
retries or disconnect to stop them. Revoked credentials, certificate changes, incompatible
protocols, conflicting controllers, and stopped/deleted simulators stop automatic retries.
Verify the Mac and pair again when required; a retry never replaces a saved certificate pin.

**Pop out display** opens a same-origin browser window. Allow pop-ups for this site if the
browser blocks it. Browser sockets cannot move between windows: opening or returning a
display disconnects its transport, stops audio, and discards unsaved recording data. Choose
**Connect display** in the new window, or **Start & connect** after returning. Returning to
a workspace that already has an active display asks you to disconnect that display first.
Closing a display releases its transport and leaves the simulator running. **Shut down
simulator** is a separate explicit action. Browser window controls and full-screen behavior
remain subject to browser permissions.

Screenshots download as PNGs, and installation uses the browser's ZIP file picker. URLs,
text paste, location, appearance, simulator creation and finite simctl commands use the
same authenticated host routes as the desktop. Browser/OS-reserved keyboard shortcuts and
clipboard permissions may differ. Use HTTPS (or loopback) for clipboard access. Mobile
browsers may suspend background tabs; direct touch remains subject to the input service's
documented gesture capabilities.

Modern hosts advertise adaptive quality, silent MP4 recording, and optional host-wide PCM
audio. The browser sends these controls and decode feedback only after capability
negotiation. Legacy hosts retain ordinary JPEG display/input and live requested-FPS changes;
changing their frame rate reconnects the display. Modern live quality controls adjust the
stream without changing its connection target. Audio uses the same explicit consent and
Mac-side opt-in as the desktop; disconnecting stops playback and capture.

Recording downloads stream through the relay with backpressure and a validated byte limit.
Browsers supporting File System Access stream directly into the selected file and discard
the host copy after a completed save. Other browsers use their download manager: the UI says
**Download started** and keeps the host copy available for retry or explicit discard. Keep
the display connected until the browser confirms completion. No large recording Blob is
assembled. Relay download links expire after 60 seconds, work once, and require the sign-in
cookie that created them; logout revokes pending links and active transfers. Mac credentials
and Mac download tickets stay out of URLs. HTTPS to the Mac still verifies its saved pin.

Diagnostics checks the selected Mac using this browser's saved pairing. Review the exact
report before downloading it. Strict schema validation excludes addresses, names,
credentials, certificate material, commands, and raw logs; export saves exactly the reviewed
JSON. A browser download start is not a claim that the file finished saving.

## Browser-local storage and reset

Saved Macs, their pinned certificates and access credentials are stored in localStorage,
namespaced by the deployment username, inside that browser profile. Selected host,
simulator and frame-rate preferences are restored without automatically booting or
controlling a device. Tabs hold independent current selections; later changes to saved
preferences apply when reopening a workspace.

This storage is not the desktop OS credential store. Anyone who can use the same browser
profile or execute scripts at this origin may read its saved Mac credentials. Use a private
browser profile on shared devices, and use **Clear saved setup** before leaving. Signing
out retains the saved setup for the next sign-in. Reset removes this user's setup from this
browser; it does not affect other profiles/devices or revoke the credential on the Mac.
Reset also cancels opening connections and prevents pairing exchanges started before the reset
from saving credentials afterward. Start a new pairing exchange to save a Mac again.
Revoke access on the Mac when disposing of an old browser profile.

Signing in or out updates sibling tabs in the same browser profile. Account changes close
old connections and open a fresh workspace for the current account, retaining each user's
saved setup separately. Each action identifies the workspace account; the hosting service
checks it against the current cookie before forwarding Mac credentials. Old workspace
references cannot act under a replacement sign-in. An older page must reload after the
hosted service is upgraded.

Logout, cookie expiry, and replacing the sign-in cancel that session's pending HTTP actions,
streams, and recording downloads. Authorization is checked again after asynchronous request
preparation. A command already dispatched to the Mac cannot be undone by signing out.

Storage is not synchronized between devices or browsers. Clearing site data, using a
private session, browser eviction, or switching the deployment's origin can remove or
separate the saved setup. Other users never receive a global server-side host list.

## Verification

Automated integration tests run one deployment with two separate sign-in cookies and two
pinned Mac credentials against a fake simulator backend. They check independent WSS input
routing, logout cleanup that leaves the other stream active, rejected cross-origin actions,
disallowed destinations, certificate-pin failure, and inaccessible state files. Native
simulator video/audio and physical touch-device/browser combinations still need native
verification. The transport suite is private; see [private validation](private-validation.md).
Run `sim-relay-web --help` for runtime settings.

The private browser workflow builds the actual React frontend and runs headless Electron checks.
The renderer regression uses a deferred fake API: it selects/connects Mac B or restores a
returned B display while saved Mac A's inventory is pending, then resolves or rejects A's
requests and obsolete returned-display connection. Assertions cover visible selection,
action routing, legacy/modern frame-rate controls, errors, and saved preferences.

The browser integration smoke runs the built app in two isolated Chromium storage/cookie
contexts against a local TLS host with a fake simulator backend. It verifies UI input and
quality isolation, streamed recording download in both browser paths, one-use/cookie-bound
links, logout invalidation, exact reviewed diagnostic export, popup blocking/return,
persistence without auto-connect, revocation, retry cancellation, and reset propagation to
an existing tab in the same browser context. Recording bytes and the File System Access
sink are test fixtures; this does not verify native capture, a real OS file picker, or audio
capture. On NixOS run from `nix develop` so Electron uses the Nix runtime; no Mac or simulator
is required. A separate shared-partition Chromium smoke uses the actual React sign-in and
reset controls to hold opening authentication across reset/account changes, suppress reset
event delivery, verify fresh account mounts and permanently invalid old APIs, and switch
cookies between preflight and action dispatch. Unit coverage also holds a pairing response
across reset and verifies that a fresh pairing can succeed afterward. The private validation workflow runs these browser checks and the separate native Electron
fake-host session smoke. Public CI runs only the published build/package checks.
