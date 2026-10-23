# Authorize and revoke clients

Each paired client receives a separate credential and a name identifying its computer and
platform. The pairing code is single-use: fetch the current code before pairing another
client. A saved client never uses the pairing code to control a simulator.

On the Mac running the host:

```sh
sim-relay-host pairing
sim-relay-host clients
sim-relay-host revoke CLIENT_ID
```

Copy the exact client ID from `clients`. Revocation disconnects all of that client's live
displays, releases their input/capture sessions, and prevents its credential from reconnecting.
Other clients remain authorized and connected. A revoked client must obtain a new code from
the Mac's owner and pair again. Pending uploads are disconnected, and requests still reading
inventory or extracting an app cannot dispatch a simulator operation after revocation.
Operations already dispatched to the simulator may finish; revocation does not undo them or
shut down the simulator. All matching streams stop input and close before their cleanup is
awaited concurrently. The administrator command waits at most one second for session cleanup;
a stalled session keeps its simulator lease until cleanup finishes.

`clients` shows pairing time, last observed activity (updated during this host run and saved
with authorization changes), and active display count. Credential values and hashes are
never included. Each client has simulator-management access as the Mac user; access is not
limited to a particular simulator or app. Duplicate names are distinguished by their IDs.

From a source checkout use `npm run host -- clients`, `npm run host -- pairing`, or
`npm run host -- revoke CLIENT_ID`.

## Choose the running host's state directory

The Terminal/background host defaults to `~/.sim-relay`. Set `SIM_RELAY_STATE_DIR` on these
commands if the running host uses a different directory. A host started inside the desktop
app uses Electron's application data directory with a `host` subdirectory. On a packaged
Mac app this is normally `~/Library/Application Support/Sim Relay/host`; source launches
may use the package name `ios-sim-stream` instead:

```sh
SIM_RELAY_STATE_DIR="$HOME/Library/Application Support/Sim Relay/host" sim-relay-host clients
```

The host must be running to manage access. Refresh its sharing details to get the current
code, or run `pairing`. A code printed at startup becomes obsolete after the first pairing.
Do not copy pairing codes or saved credentials into bug reports.

## Upgrade from shared tokens

Protocol 2 hosts replace shared-token authorization. On first startup after upgrading, the
host rotates the old shared token and starts with no authorized clients. Update old clients
and pair each one again using a current code. Previously saved shared tokens cannot control
the upgraded host or authorize new clients. The certificate remains the same; verify its
fingerprint as usual. New clients can still connect to protocol 1 hosts, whose shared-token
limitations continue until the host is upgraded.

## Storage and administrator access

The host stores client credential SHA-256 hashes in `clients.json`, with file permissions
`0600`. The host state directory is private (`0700`). The current pairing code remains in
the private `token` file for local status commands. The TLS private key stays on the host.
Desktop client credentials retain OS-encrypted storage; if that storage is unavailable,
the desktop keeps the credential in memory for the current session only.

Management uses `clients.sock`, a local Unix socket inside that private directory, with
permissions `0600`. There is no network administrator endpoint. A process running as the
same Mac user can administer the host, just as it can operate that user's simulator directly.
Do not share the state directory or run multiple hosts against the same directory.

Automated tests exercise delayed uploads, revocation during inventory and archive preparation,
and multiple fake-backend streams over pinned TLS/WSS. They verify that stalled or failed
cleanup cannot keep another revoked stream active, that extracted app directories are removed,
and that another client's input keeps working. Actual macOS Simulator and OS-keychain behavior
still require native platform verification.
