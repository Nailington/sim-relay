# Host browser workspaces

The browser service can run on the simulator Mac or a Linux/Windows/macOS machine that
can reach the Mac host. Clients need a current browser; they do not need Electron or
Node.js. The hosting machine needs Node.js 24, this repository, and network access to
the configured Macs. Simulator capture and control still run on Macs with Xcode and
idb_companion.

## Start a deployment

From this repository, install dependencies and build the frontend:

```sh
npm ci
npm run build
```

Set these environment variables using your deployment's private environment file or
secret manager. Do not commit passwords to the repository:

```text
SIM_RELAY_WEB_USERS={"alice":"<unique password of at least 16 characters>","bob":"<another unique password>"}
SIM_RELAY_WEB_HOSTS=https://studio-mac.local:49300,https://192.168.1.20:49300
SIM_RELAY_WEB_PORT=49301
SIM_RELAY_WEB_BIND=127.0.0.1
```

Then run `npm run web`. The default local URL is `http://127.0.0.1:49301`. The
service requires configured users and an explicit allowlist of HTTPS Mac host origins.
Add every address clients will enter, including SSH-tunnel addresses if used. The list
limits the endpoints the relay can probe; it is not a per-user simulator permission list.
Each Mac independently authorizes each browser client.

For direct LAN access, configure `SIM_RELAY_WEB_CERT` and `SIM_RELAY_WEB_KEY` with
certificate and private-key paths, set `SIM_RELAY_WEB_BIND=0.0.0.0`, and set
`SIM_RELAY_WEB_ORIGIN=https://your-server-name:49301`. Browsers must trust that
certificate. This is the browser service's certificate, separate from each Mac host's
pinned certificate. Keep private-key files readable only by the hosting user.

For a reverse proxy, keep the bind address on loopback and set
`SIM_RELAY_WEB_ORIGIN=https://sim-relay.example.com`. Terminate TLS at the proxy,
preserve the public `Host` header, forward the HTTP routes, and enable WebSocket upgrade
for `/api/stream`. Restrict access to the relay's listening port so clients cannot bypass
the proxy. Set the proxy upload limit to at least 128 MB and its request timeout to over
two minutes. The service checks `Host` and `Origin`, and sign-in cookies use HttpOnly,
SameSite=Strict and Secure on HTTPS deployments. Remote plain-HTTP origins are rejected.

Sign-ins expire after 12 hours. Restarting the service invalidates sign-ins and releases
all live relay sessions; sign in again to use saved browser-local pairings. Change/remove
a user in `SIM_RELAY_WEB_USERS` and restart to revoke that deployment login. The Mac's
`sim-relay-host revoke CLIENT_ID` separately revokes a browser's access to that Mac.

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
Revoke access on the Mac when disposing of an old browser profile.

Sign-in changes invalidate workspaces and API instances opened under the previous account,
including sibling tabs sharing the same cookie. Each action identifies the workspace account;
the hosting service checks that identity against the current sign-in before forwarding Mac
credentials. An older page must reload after the hosted service is upgraded.

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
verification. Run `npm test` for the transport tests and `npm run web -- --help` for settings.

`npm run test:browser` builds the actual React frontend and runs headless Electron checks.
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
is required. Linux CI runs both browser checks and the separate native Electron fake-host
session smoke.
