# Homebrew cask

Stable releases generate `sim-relay.rb` with the version, architecture mapping, and
SHA-256 checksums. This copy supports existing installations from this repository.

Install Sim Relay from the [Nailington tap](https://github.com/Nailington/homebrew-tap):

```sh
brew install --cask nailington/tap/sim-relay
```

New generated casks install the desktop app and link its bundled `sim-relay-host`,
`sim-relay-web`, and `sim-relay-upgrade` commands into
Homebrew's `bin` directory. No system Node.js or npm installation is needed.
Use `sim-relay-upgrade` for coordinated background-host upgrades; see the macOS guide for
first-upgrade and failure recovery. Plain `brew upgrade` does not run that handoff.

Use `sim-relay-host start` to run it in the background; `stop` disables it. Uninstalling
the cask also stops and removes its per-user background service.

See [macOS installation](../docs/macos.md) and [release setup](../docs/releasing.md).
