# CI and releases

`.github/workflows/ci.yml` type-checks the application and builds installers on every branch
push, pull request, and manual run. Its reusable `desktop.yml`
builds natively on six runners: macOS arm64/x64, Windows arm64/x64, and Linux arm64/x64.
CI uploads downloadable artifacts for seven days. It also evaluates every flake output and
builds the x86_64 Linux Nix package. Test suites and test runners stay local and are excluded
from the published repository and Nix source inputs.

`.github/workflows/release.yml` runs when a `v*` tag is pushed. It validates the version,
runs the same complete CI, checks the presence of all fourteen installers, computes SHA-256
checksums, and publishes a GitHub Release. Uploads finish in a draft before publication.
The release contains DMG/ZIP, EXE, AppImage/tar.gz/DEB/RPM, `SHA256SUMS`, `release.json`, and, for stable
versions, the generated `sim-relay.rb` Homebrew cask. Generated GitHub change notes accompany
installation and signing information. There is no in-app auto-updater.

Both Linux architectures produce all four formats. Debian packages use `amd64`/`arm64`
architecture labels; RPM packages use `x86_64`/`aarch64`. CI inspects the package architecture,
application archive, and desktop menu entry before uploading. Windows ARM64 builds run on
the native `windows-11-arm` runner.

## One-time setup

Enable GitHub Actions in the repository. The release and Homebrew jobs request `contents:
write` using the built-in `GITHUB_TOKEN`; no personal token or separate tap repository is
required. Normal build jobs remain read-only.

For Apple signing, follow [the macOS guide](macos.md#signing-releases-with-your-apple-developer-program-account).
Without signing configuration, the pipeline produces clearly labeled unsigned/ad-hoc builds.
Optional Windows certificate signing uses repository variable `WINDOWS_SIGNING_ENABLED=true`
plus secrets `WIN_CSC_LINK` (base64 exported `.pfx`/`.p12`) and `WIN_CSC_KEY_PASSWORD`.
Apple membership does not provide a Windows signing certificate. Once either platform's
signing variable is enabled, missing or invalid credentials fail its build.

Stable releases write the generated, versioned cask to `Casks/sim-relay.rb` on the default
branch. This is what makes `brew update` and `brew upgrade` work. The workflow checks the
current cask version and never replaces it with an older or equal release. It does not
force-push. The first stable release creates the cask; Homebrew installation is available
after that job succeeds.

If branch protection blocks the Homebrew bot's commit, the GitHub Release remains available
and the Homebrew job fails visibly. Download the attached `sim-relay.rb`, submit that file
as `Casks/sim-relay.rb` through your usual PR process, and merge it. Alternatively configure
an appropriate repository ruleset for automated cask updates. Do not disable protection
for all source changes just to update a cask. Re-run only the failed Homebrew job to retry
after fixing permissions or a non-fast-forward push.

## Publish a version

1. Update `package.json` and `package-lock.json` together:

   ```sh
   npm version 0.2.0 --no-git-tag-version
   ```

   Choose the intended version; `0.2.0` is an example. For the initial release, the repository
   already uses `0.1.0` and no version bump is needed.

2. Update `npmDepsHash` in `nix/package.nix` whenever the lockfile changes. Temporarily set
   it to `lib.fakeHash`, build the flake, and copy the reported actual hash. Stage new source
   files before building a local Git flake. The Nix package version reads `package.json`
   automatically, so there is no separate flake version to edit.
3. Run `npm run check`, `npm run build`, and `nix build`. Commit the version, lockfile, Nix hash,
   and any release changes, and push them to the default branch. Let CI pass.
4. Tag that tested commit and push the tag:

   ```sh
   git tag -a v0.2.0 -m "Sim Relay 0.2.0"
   git push origin v0.2.0
   ```

The tag must exactly match `package.json` and both lockfile version fields. Accepted tags
are `vX.Y.Z`, `vX.Y.Z-alpha.N`, `vX.Y.Z-beta.N`, and `vX.Y.Z-rc.N`. Pre-releases build every
platform but are marked as pre-releases, never become Latest, and do not update Homebrew.
Release jobs run serially; push one release tag at a time.

Watch [Actions](https://github.com/Nailington/sim-relay/actions), then check
[Releases](https://github.com/Nailington/sim-relay/releases). No release is published if
any native build, package validation, Nix check, or requested signing step fails. A failed upload leaves
a draft that can be retried. An already published version is never overwritten: publish
a new version for corrected binaries, and do not move released tags.

Nix users can pin `github:Nailington/sim-relay/v0.2.0`, or update their existing `sim-relay`
input to follow the default branch. Homebrew uses each release's pinned DMG URLs and checksums.
The flake remains a source build and does not consume the GitHub installers.
