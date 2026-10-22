# Homebrew tap

The first stable tagged release generates `sim-relay.rb` here with its version, architecture
mapping, and SHA-256 checksums. Later stable releases update it automatically on the default
branch. No placeholder URLs or checksums are used before a release exists.

After that first release completes:

```sh
brew tap nailington/sim-relay https://github.com/Nailington/sim-relay.git
brew install --cask nailington/sim-relay/sim-relay
```

See [macOS installation](../docs/macos.md) and [release setup](../docs/releasing.md).
