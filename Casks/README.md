# Homebrew tap

The first stable tagged release generates `sim-relay.rb` here with its version, architecture
mapping, and SHA-256 checksums. Later stable releases update it automatically on the default
branch. No placeholder URLs or checksums are used before a release exists.

After that first release completes:

```sh
brew tap nailington/sim-relay https://github.com/Nailington/sim-relay.git
brew install --cask nailington/sim-relay/sim-relay
```

New generated casks install the desktop app and link its bundled `sim-relay-host`,
`sim-relay-web`, and `sim-relay-upgrade` commands into
Homebrew's `bin` directory. No system Node.js or npm installation is needed.
Use `sim-relay-upgrade` for coordinated background-host upgrades; see the macOS guide for
first-upgrade and failure recovery. Plain `brew upgrade` does not run that handoff.

Use `sim-relay-host start` to run it in the background; `stop` disables it. Uninstalling
the cask also stops and removes its per-user background service.

See [macOS installation](../docs/macos.md) and [release setup](../docs/releasing.md).
