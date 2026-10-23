# Install and set up Sim Relay on macOS

The desktop client requires macOS 13 Ventura or newer and runs on Apple Silicon and Intel.
Only a Mac that shares simulators needs Xcode, an iOS runtime, and `idb_companion`.
A Mac used only as a client does not need those tools.

## Install a release

Open [GitHub Releases](https://github.com/Nailington/sim-relay/releases/latest).
In **Apple menu → About This Mac**, a **Chip** entry means Apple Silicon (`arm64`);
an Intel **Processor** entry means `x64`.

Download `Sim-Relay-VERSION-mac-arm64.dmg` or `Sim-Relay-VERSION-mac-x64.dmg` for your Mac.
Open the disk image, drag **Sim Relay** to **Applications**, eject the image, and open the app.
The corresponding ZIP is an alternative: extract it and move **Sim Relay.app** to Applications.
Node.js is included in the app runtime; no separate Node installation is required.

To use the host from Terminal after installing the DMG or ZIP, choose **Sim Relay →
Install host command…** in the app menu. Approve the macOS administrator prompt, then open
a new Terminal window and run:

```sh
sim-relay-host
```

This links the bundled command into `/usr/local/bin`. Keep the app in Applications;
replacing it there during an upgrade also updates the command. If your shell uses a custom
PATH, include `/usr/local/bin`. To remove a manually installed command, run
`sudo rm /usr/local/bin/sim-relay-host`. Removing the link does not delete pairing state.

Release notes and `release.json` state whether that release is Developer ID signed and
notarized. For an unsigned/ad-hoc build that you trust, attempt to open it, then use
**System Settings → Privacy & Security → Open Anyway** and confirm. See
[Apple's instructions for opening apps](https://support.apple.com/en-us/102445).
Do not disable Gatekeeper globally. Managed Macs may require administrator approval.

## Install with Homebrew

After the first stable release has completed its **homebrew** job, this repository also
serves as a custom tap. Homebrew selects the matching Mac architecture and checks the
release's SHA-256 checksum:

```sh
brew tap nailington/sim-relay https://github.com/Nailington/sim-relay.git
brew install --cask nailington/sim-relay/sim-relay
open -a "Sim Relay"
```

Homebrew also installs `sim-relay-host` on your PATH automatically. Run it from any
directory; there is no separate Node.js, npm, or source checkout setup. You do not need
the app's **Install host command…** menu item when installing with Homebrew. Homebrew
upgrades and uninstalls manage the command along with the app.

Use the explicit Git URL when tapping: the repository is named `sim-relay`, rather than
Homebrew's conventional `homebrew-sim-relay`. To upgrade:

```sh
brew update
brew upgrade --cask nailington/sim-relay/sim-relay
```

Homebrew does not install Xcode or `idb_companion` for client-only use. It also does not
bypass macOS security prompts for unsigned builds. Pre-releases do not update this tap.
To uninstall, use `brew uninstall --cask nailington/sim-relay/sim-relay`. Adding `--zap`
also removes the desktop app's saved pairings and settings; CLI state in `~/.sim-relay`
is kept separately.

## Share simulators from this Mac

1. Install full **Xcode** from the Mac App Store or Apple's developer downloads. Open it,
   accept the license, finish its setup, and install an iOS runtime in **Xcode → Settings →
   Components**. The command-line tools package alone does not include iOS Simulator.
2. Select your Xcode installation if needed:

   ```sh
   sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
   xcrun simctl list runtimes
   ```

3. Install the native input/video companion:

   ```sh
   brew tap facebook/fb
   brew install idb-companion
   ```

   The host searches `/opt/homebrew/bin`, `/usr/local/bin`, and `PATH`. A custom installation
   can be selected with `IDB_COMPANION_PATH`. The real host tests used Apple Silicon,
   macOS 15.7.1, Xcode 26.0.1, iOS 26, and companion 1.7.7. Other Xcode/companion combinations,
   particularly Intel hosts, still need compatibility testing.

4. Open **Sim Relay → Set up a Mac host → Start sharing**. Check the dependency readiness
   shown there. Allow **Local Network** access when requested and allow incoming app
   connections in the macOS firewall. The default host endpoint uses TCP port **49300**;
   Bonjour discovery uses mDNS. You do not need router port forwarding for a local network.
5. Keep the Mac awake and the host app running. On the client, select the Mac or enter its
   address, compare the certificate fingerprint with the host, and enter the host's pairing
   token. Select or create a simulator, then **Start & connect**.

If discovery does not find the Mac, enter its IP address directly. Check **System Settings →
Privacy & Security → Local Network** and firewall permissions. For direct Ethernet,
Thunderbolt networking, or SSH tunnels, see [connection instructions](../README.md#local-and-direct-connections).

For a Terminal host, run `sim-relay-host` instead of starting sharing in the desktop app.
Use `sim-relay-host --help` for settings and `sim-relay-host --version` to check the installed
version. Only run one host at a time; the desktop host and CLI use the same default port
but keep separate pairing state.

For source development, clone this repository, install Node.js 24, and run
`npm ci` followed by `npm run host` or `npm run dev`. Nix users can use the
[existing flake](../README.md#install-with-nix); its package also provides `sim-relay-host`.

## Signing releases with your Apple Developer Program account

Yes: a paid Apple Developer Program membership supports Developer ID signing and notarization
for distribution through GitHub and Homebrew. This pipeline does not submit to the Mac App Store.
Apple documents the certificate types and Account Holder requirement in its
[Developer ID certificate guide](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/).

### Create and export the signing certificate

On your Mac, use **Keychain Access → Certificate Assistant → Request a Certificate From a
Certificate Authority** to save a certificate signing request (CSR) to disk. In your
[Apple Developer account](https://developer.apple.com/account/resources/certificates/list),
create a **Developer ID Application** certificate using that CSR. Download the `.cer` and
double-click it on the same Mac, where its private key was created.

In Keychain Access, open **My Certificates**. Select the Developer ID Application identity
with its private key, choose **Export**, and save a password-protected `.p12`, for example
`~/Downloads/SimRelay-DeveloperID.p12`. If export is unavailable or the private key is absent,
use the Mac that created the CSR. This workflow needs an exportable local identity;
a cloud-managed certificate alone is insufficient.

### CLI alternative: generate the CSR with OpenSSL

You can generate the private key and CSR from a terminal, including over SSH on the Mac.
Replace the example email and name with your own. From the project checkout:

```sh
umask 077
mkdir -p .signing
cd .signing
openssl genrsa -aes256 -out DeveloperID.key 2048
openssl req -new -sha256 -utf8 -key DeveloperID.key \
  -out DeveloperID.certSigningRequest \
  -subj "/emailAddress=you@example.com/CN=Your Name"
openssl req -in DeveloperID.certSigningRequest -noout -verify
```

OpenSSL prompts for the key's passphrase; keep it so you can later use the key. Upload only
`DeveloperID.certSigningRequest` when creating the **Developer ID Application** certificate
in Apple's developer portal. Keep `DeveloperID.key` private. The downloaded certificate
must be paired with this same private key when you create the `.p12` for GitHub signing.
See [Apple's CSR guide](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request)
and [OpenSSL's CSR command reference](https://docs.openssl.org/3.5/man1/openssl-req/).

The one-time setup file is `.signing/.env`. It holds the `.p12` and `.p8` file paths,
certificate export password, Key ID, and Issuer ID for uploading with `gh`. The `.signing/`
directory is Git-ignored, excluded from the package and Nix build source, and outside
Vite's automatic root `.env` loading. Do not source it before running the desktop app.

### Create a notarization key

In [App Store Connect → Users and Access → Integrations](https://appstoreconnect.apple.com/access/integrations/api),
request API access if needed. Under **Team Keys**, generate an API key with **App Manager**
role, download its `.p8` file, and record its **Key ID** and **Issuer ID**. Keep the downloaded
key securely; Apple only offers the download once. This workflow uses a team key with an
Issuer ID. See [Apple's API key instructions](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/)
and [Electron's notarization authentication guide](https://github.com/electron/notarize#usage-with-app-store-connect-api-key).

### Configure GitHub Actions

In [the repository's Actions secrets](https://github.com/Nailington/sim-relay/settings/secrets/actions),
add these repository secrets:

- `MAC_CSC_LINK`: the **base64 contents** of your exported `.p12`.
- `MAC_CSC_KEY_PASSWORD`: the password you chose when exporting the `.p12`.
- `APPLE_API_KEY_P8`: the complete `.p8` file text, including its BEGIN/END lines.
- `APPLE_API_KEY_ID`: the key's Key ID.
- `APPLE_API_ISSUER`: the team key's Issuer ID.

You can upload them privately with the GitHub CLI on your Mac. Replace the `.p8` path with
your downloaded key's actual filename; the commands without input redirection prompt for
their values:

```sh
gh auth login
base64 -i "$HOME/Downloads/SimRelay-DeveloperID.p12" | gh secret set MAC_CSC_LINK --repo Nailington/sim-relay
gh secret set MAC_CSC_KEY_PASSWORD --repo Nailington/sim-relay
gh secret set APPLE_API_KEY_P8 --repo Nailington/sim-relay < "$HOME/Downloads/AuthKey_KEYID.p8"
gh secret set APPLE_API_KEY_ID --repo Nailington/sim-relay
gh secret set APPLE_API_ISSUER --repo Nailington/sim-relay
gh variable set MACOS_SIGNING_ENABLED --body true --repo Nailington/sim-relay
```

Set `MACOS_SIGNING_ENABLED=true` only after adding all five secrets. No Apple login password,
app-specific password, Team ID secret, or separate Developer ID Installer certificate is
needed for this API-key/DMG workflow. Keep the `.p12`, its password, and `.p8` out of Git and chat.

Push a version tag using the [release instructions](releasing.md). The Mac jobs import the
certificate, sign with hardened runtime, submit to Apple's notary service, and staple its
ticket. A missing credential, signing error, or notarization rejection fails the release;
the requested signed build never silently becomes unsigned. Normal PR/branch builds do not
receive signing credentials. Until signing is enabled, release notes label Mac builds as
ad-hoc signed and not notarized.

After installing a signed release, verify it locally:

```sh
codesign --verify --deep --strict --verbose=2 "/Applications/Sim Relay.app"
spctl --assess --type execute --verbose=2 "/Applications/Sim Relay.app"
xcrun stapler validate "/Applications/Sim Relay.app"
```

The Nix package continues to use the nixpkgs Electron runtime and is built independently;
Apple signing credentials apply to the downloadable DMG/ZIP releases.
