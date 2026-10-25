# Integrated validation — 2026-10-25

Application commit: `e8982192c8028d967295dcdea34dd7fde42bad14`.
Displayed version: 0.1.5 (unreleased changes; no release or main merge authorized here).
Private suite manifest SHA-256: `7d5f94b341127c582077a30cfbc32fa22ff329829b89d7443d4d8818193e1061`.
The manifest hashes sorted relative names in `tests/`, NUL, then each file's binary
SHA-256, concatenated into SHA-256. A restricted local checkpoint preserves the suite,
manifest and logs. This report contains no test sources or raw captures.

Environment: NixOS 26.11 (26.11.20261017.353adf2), Linux x64, host Node 24.21.0,
Electron 45.0.0. The actual packaged runtime reports Node 24.22.0 and Chromium
156.0.8078.48. All Mac/Xcode/runtime/companion fields are not applicable to these
injected-backend Linux checks. Historical native versions are in the
[acceptance ledger](release-acceptance.md).

## Passed

- `npm run build`, including TypeScript checking and production renderer/main/preload,
  host, web and frontend builds.
- `node --import tsx --test tests/*.test.*`: **185 passed**, zero failures/skips.
  Covers pinned HTTPS/WSS authorization, per-client scope/CAS, revoke/body/dispatch
  races, account/reset generations, bounded media, updates/migration, exact-certificate
  aliases and no action replay, recording decisions and shutdown retirement.
- The retirement subset has **16 passing checks**, including actual abortable Node
  children, SIGKILL escalation, deferred HTTP/finally after revoke, installation staging
  cleanup, sticky shutdown timeout, fatal pending display-startup cleanup, and an
  already signal-terminated companion. Native partial-startup cleanup failures must
  remain fatal to retirement acknowledgment.
- Private built Electron/Chromium renderer, browser workspace and sibling-account
  identity smokes passed at `29375a5390174106ec1d85b9c044742360907641`. The final
  review fixes changed host retirement and Darwin packaging only. The built client,
  preload, frontend entry and web-server bytes still match that inspected package.
  The native Electron window-routing/recording smoke was rerun successfully on the
  final commit. Browser flows cover actual distinct cookie contexts, streaming saves,
  strict reviewed export, popup/return, logout/reset and permanent stale-API rejection.
- The private recording UI matrix passed with the same UI source on sibling `ccd10da`,
  including Cancel preserving selection/FPS/session, finalization, confirmed file-close
  ordering, fallback false, failures, nested dialogs/Escape, desktop transfer exemption,
  browser return and all-local-owner close/host decisions. Browser and built Electron
  smokes additionally exercise active-route/re-pair Cancel and multiple capture owners.
- An actual Linux unpacked Electron payload passed its published content check:
  application archive/resources exclude project-private tests, fixtures and runners;
  the web entry, frontend and installed command are present. Final client/preload/web
  bytes were compared against the inspected payload after review fixes.
- The real packaged `sim-relay-web` launcher ran from `/` with a private temporary
  runtime file, served its frontend, rejected unauthenticated session requests, exited
  zero on SIGTERM and restarted on the same loopback port. Owned processes and the
  temporary config were removed.
- `nix flake check --all-systems --no-build` and
  `nix build --no-link .#sim-relay .#sim-relay-web` passed for x86_64 Linux.
  Actual evaluated desktop/web source trees exclude private validation paths. The
  evaluated aarch64-Darwin install phase maps `Resources/host` to `dist-host`, matching
  the GUI's packaged host entry. That last check is evaluation, not a Mac runtime pass.

## Review dispositions

Independent foundation review found premature retirement after cancelling HTTP work.
`0daa113` now joins full handlers, archive cleanup and observed child exit, and fails
closed on deadline. A second independent review at `29375a5` found fatal startup
cleanup being swallowed, an already signaled companion waiting for a past exit event,
and a missing Nix Mac GUI host resource. `e898219` fixes all three; the first two have
new behavior regressions, and the Nix resource mapping was checked in the evaluated
Darwin derivation. The fixes were verified locally; no separate independent approval
of that final patch is claimed.

## Limits and next gates

These are fixture and packaging results. They do not establish actual Simulator
rotation/hit targets, representative app gestures, Mac sleep/wake, real network loss,
Windows/macOS window/installer/keychain behavior, native OS pickers, real browser
native-download completion, Homebrew/launchd/caffeinate acceptance, signing/notarization,
audible audio/output switching, lip-sync or shaped-WAN video latency. Fake MP4/audio,
injected picker/sink results and expected-negative IPC logs are deliberate fixtures.
The background-host action smoke reaches the expected Mac-only rejection on Linux;
it does not start a real macOS service.

The initial Mac audio permission denial and the owner's instruction to continue
without audio validation remain in effect; no Mac/TCC/audio/SSH work occurred here.
No native recording-retention grace is implemented: forced revocation/disconnect
removes unsaved host data. External CLI/remote host shutdown requires saving first.
Follow the [acceptance ledger](release-acceptance.md) before release and keep related
issues open until their own criteria are met. The seven public build checks and
this private evidence are separate gates. Later functional changes require affected
checks to be rerun; documentation-only report commits do not change this tested tree.
