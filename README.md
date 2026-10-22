<img src="assets/app-icon.svg" width="72" height="72" alt="Sim Relay icon">

# Sim Relay

A graphical desktop client for iOS simulators running on another Mac. The Electron app runs
on macOS, Windows, and Linux. The Mac runs Xcode's actual iOS Simulator; clients receive its
framebuffer and send native input over an encrypted connection. No cloud account or physical
iPhone is required.

This is a working first version, **not yet complete parity with the native Mac Simulator**.
See the current limits below.

## Run the desktop app

Packaged builds are in `release/`: a macOS DMG/ZIP, a Windows installer, and a Linux
AppImage/portable archive. Packaged apps include their runtime and do not require Node.js.
Open the installer or app for your desktop, then follow the Mac host setup below.

To run from source instead:

Install Node.js 22 or newer, then from this checkout:

```sh
npm ci
npm run dev
```

`npm run dev` opens an Electron window and starts its UI development server. `npm run dev:ui`
opens only the browser preview, which uses clearly labeled, simulated demo data. Real
connections run through Electron's isolated native bridge and are unavailable in the browser.

## Install with Nix

The flake provides `packages.<system>.default` (also named `sim-relay`),
`apps.<system>.default`, `overlays.default`, and `devShells.<system>.default` for
x86_64/aarch64 Linux and aarch64 macOS. It builds from the npm lockfile and uses nixpkgs' Electron
runtime. The Linux package includes a desktop menu entry; the macOS package includes
`Applications/Sim Relay.app`. Nix builds are verified on x86_64 Linux; the other Nix targets
still need native build/runtime validation. The pinned nixpkgs no longer supports Intel macOS.

Add the GitHub repository as an input to your flake:

```nix
inputs.sim-relay.url = "github:Nailington/sim-relay";
```

Then include the package in a NixOS module (with `inputs` passed through `specialArgs`):

```nix
{ inputs, pkgs, ... }:
{
  environment.systemPackages = [
    inputs.sim-relay.packages.${pkgs.stdenv.hostPlatform.system}.default
  ];
}
```

For Home Manager, use the same package in `home.packages` and pass `inputs` through
`extraSpecialArgs`. Alternatively, add `inputs.sim-relay.overlays.default` to
`nixpkgs.overlays` and install `pkgs.sim-relay`. The overlay uses your nixpkgs; the direct
package uses this project's pinned nixpkgs. You may set
`inputs.sim-relay.inputs.nixpkgs.follows = "nixpkgs"` to share your pin, provided it has
Electron 43 or newer and Node.js 24.

Build or launch directly from GitHub without installing:

```sh
nix build github:Nailington/sim-relay
nix run github:Nailington/sim-relay
# On a Mac with Xcode and idb_companion installed:
./result/bin/sim-relay-host
```

The host still requires the Mac setup below; Nix does not install Xcode or iOS runtimes.
For development in a local checkout, run `nix develop .`, then `npm ci` and `npm run dev`.
The shell uses Nix's Electron rather than downloading another runtime.

After changing `package-lock.json`, update `npmDepsHash` in `nix/package.nix`: set it to
`lib.fakeHash`, run `nix build .`, and replace it with the reported `got: sha256-…`
hash. `nix flake check .` builds the package and runs its tests.

## Set up the Mac

The tested host is Apple Silicon, macOS 15.7.1, Xcode 26.0.1, iOS 26.0, and `idb_companion` 1.7.7.
Install Xcode, open it to finish setup, and install an iOS runtime under **Xcode → Settings →
Components**. Select that Xcode installation with `xcode-select` if needed.

Install the native input and video dependency:

```sh
brew tap facebook/fb
brew install idb-companion
```

Use a recent companion with pinch, shake, and orientation support. The current companion
requires compatible macOS and Xcode versions; older Intel/Xcode combinations are unverified.
The host searches `/opt/homebrew/bin`, `/usr/local/bin`, and `PATH`. Set `IDB_COMPANION_PATH` for
a custom installation.

In the desktop app on the Mac, select **Set up a Mac host → Start sharing**. Alternatively,
with Node.js and this project on the Mac:

```sh
npm ci
npm run host
```

Keep the Mac awake and the host running. It shows its address, pairing token, SHA-256
certificate fingerprint, and dependency readiness. Allow incoming connections through the
Mac's firewall for LAN access. Default port: TCP **49300**. Discovery uses Bonjour/mDNS.
On macOS, allow Local Network access when requested; see [Apple’s local network privacy guide](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).

On the client, choose a nearby Mac or **Connect a Mac**, enter its address, compare the
fingerprint with the Mac, and enter its pairing token. Pick an existing simulator or create
one with an installed runtime, then select **Start & connect**.

## Local and direct connections

Wi-Fi, Ethernet, directly connected Ethernet adapters, Thunderbolt networking, and other
routable IP connections use the same HTTPS endpoint. Discovery is optional: enter an IP address
when mDNS is blocked. USB cables without an IP network interface are not supported.

SSH tunnels also work, including with Windows OpenSSH. On the Mac:

```sh
SIM_RELAY_BIND=127.0.0.1 npm run host
```

On the client, keep this tunnel open:

```sh
ssh -N -L 49300:127.0.0.1:49300 user@your-mac
```

Connect to `https://127.0.0.1:49300` using the same Mac fingerprint and token. Loopback-only
hosts are not advertised through Bonjour.

## Controls

- Click, double-click, drag, and click-and-hold send native touch input. Coordinates map to
  simulator points independently of stream pixel resolution. Focus loss/disconnect releases
  held contacts and keys.
- Click the display to type. Letters, modifiers, navigation, and function keys use USB HID.
- **Alt + drag** or **Ctrl + scroll** performs a two-finger pinch. The wheel scrolls using
  native swipes. Pinch is sent as a completed gesture.
- The inspector provides Home, Lock, rotation, shake, volume, PNG screenshots, appearance,
  deep links, location, and **Paste text**. Paste text uses the simulator clipboard and
  Command+V, including Unicode; focus an iOS text field first.
- **Install app** transfers a ZIP containing one simulator `.app` from any client OS.
  Build for the simulator, not a physical device. On a Mac, create an archive with
  `ditto -c -k --keepParent MyApp.app MyApp.app.zip`. Limits: 128 MB compressed, 512 MB expanded,
  20,000 files. Archive symlinks become regular files. Install bundles that require symlinks
  directly from the Mac filesystem using the command panel.
- **Command panel** (Ctrl+K / Cmd+K) runs `simctl` arguments directly, without a shell.
  `$DEVICE` means the selected simulator. Launch/uninstall apps, send notifications, change
  permissions, import media, or use other finite `simctl` operations. Paths refer to the Mac.
  Erase/delete commands require a checkbox. Commands time out after two minutes.
- `/` focuses simulator search when outside text fields and the simulator display.

Each simulator permits one controlling client at a time. Separate simulators can have separate
clients. Disconnecting leaves the simulator running; **Shut down simulator** powers it off.

## Current limits

- Arbitrary simultaneous multi-finger paths, two-finger twist/rotation gestures, pressure,
  and stylus input are not implemented. The public idb streaming protocol used here exposes
  single-contact input and a predefined pinch. Device orientation rotation is supported.
- Streaming uses full-resolution MJPEG over TLS, requested 15/30/60 fps, frame dropping under
  backpressure, and actual decoded-frame measurements. H.264/WebRTC, adaptive bitrate, audio,
  recording controls, and guaranteed 60 fps are not implemented. MJPEG uses more bandwidth
  than an inter-frame video codec.
- Simulator-specific GUI menus, full Mac desktop control, Xcode editing/building/debugging,
  physical-device features, and long-running console sessions are outside this version.
- Intel hosts, Windows desktop behavior, signing, and notarization need platform validation.
  Linux and macOS Electron clients have both decoded real simulator video from the Mac host.
  Windows installer generation passes; its runtime still needs a Windows machine.
  Windows/macOS installer targets and a CI build matrix are configured.

## Security and storage

The host uses TLS, a persistent certificate, and a random 192-bit bearer token. Pairing verifies
the fingerprint before sending the token. Subsequent HTTPS/WebSocket traffic validates the
pinned certificate. The companion uses a private Unix socket, not an exposed gRPC port.
Browser origins are rejected. The renderer has no Node integration or unrestricted IPC.

Pairing grants simulator management access as the Mac user, including simulator commands.
Give the token only to trusted clients. Saved client tokens use operating-system encryption.
Without secure storage, pairing stays in memory for that session; plaintext persistence is disabled.

CLI host state lives in `~/.sim-relay`; desktop host state lives under Electron's user-data
directory. To revoke paired clients, stop sharing and remove the host's `token` file; starting
again generates a new token. Replacing the host certificate requires pairing again.

Host variables: `SIM_RELAY_PORT`, `SIM_RELAY_BIND`, `SIM_RELAY_STATE_DIR`, `IDB_COMPANION_PATH`.
Clients do not need Xcode or idb.

## Build and verify

```sh
npm run check
npm test
npm run build
npm run package:dir
npm run package
```

Build installers on their target OS. Outputs go to `release/`: macOS DMG/ZIP, Windows NSIS,
Linux AppImage/tar.gz. Builds are unsigned; public distribution needs platform signing/notarization.
`.github/workflows/desktop.yml` defines builds and tests for all three systems. The workflow
must run in a connected GitHub repository.

Tests cover TLS/pinning, authentication, command confirmation, WebSocket input, gesture
ordering/draining, coordinates, JPEG framing/dimensions, command parsing, and app archive
extraction. `npm audit` currently reports no vulnerabilities.

Native Electron smoke test, after building:

```sh
npx electron scripts/desktop-smoke.cjs
```

It uses a temporary profile and captures `/tmp/sim-relay-desktop.png`. Linux container tests
may need `--no-sandbox --ozone-platform=x11 --disable-gpu` **for that test only**. Production
code does not disable its renderer sandbox.

Real Mac smoke test: set `SIM_RELAY_TEST_URL` and `SIM_RELAY_TEST_TOKEN_FILE` to an HTTPS host
and a private file containing its token, then run `npm run test:mac`. It creates and removes an
isolated simulator. Never commit pairing tokens.

## Implementation

- `src/electron`: native window, discovery, encrypted profiles, pinned transport, file pickers,
  and restricted preload bridge.
- `src/host`: HTTPS/WebSocket service, `simctl`, app installation, and per-session companion
  processes. Completed gestures drain their own HID RPC on a persistent companion connection.
- `src/renderer`: React workspace/dialogs, canvas video, keyboard/touch mapping, labeled demo.
- `tests` and `scripts`: automated checks, desktop/real-Mac verification, and packaging.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for protocol licensing.
