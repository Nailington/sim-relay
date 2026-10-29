# Unreleased upgrade notes

Protocol 2 replaces the Mac host's shared bearer token with individual client
credentials. Update clients first, save recordings, then upgrade/restart the host.
Each device and browser must pair again with the Mac's current single-use code;
refresh the code after each successful pairing. Keep the existing host state directory,
certificate and simulator data. Verify the fingerprint during every re-pair.

Updated clients remain compatible with protocol 1 hosts, whose shared code still
provides broad shared access without individual revocation. New protocol 2 pairings
use least-privilege device/action grants configured by the Mac owner. A permissions
error requires an owner grant, rather than another pairing exchange.

The Updates action checks official release metadata and shows the proper upgrade
route. Optional daily checking is off by default. It does not install over Homebrew,
Nix or another package manager. Background-host and browser-service upgrades interrupt
sessions; save recordings first and use the documented service handoff.

## Scope and compatibility

- Requested rotation works through Sim Relay. Older companions that do not report
  orientation cannot follow rotation made in Simulator.app; use Sim Relay's Rotate
  control or a companion with orientation reporting.
- Gestures include single-contact input and discrete pinch steps. Independent contact
  paths, continuous two-finger pinch and twist are not supported.
- Each simulator has one exclusive display lease, including viewers. Simultaneous
  controller and viewer connections to the same simulator are not supported.
- Audio shares all playback from the Mac, with explicit consent and one audio owner.
  It requires local opt-in, supported macOS/helper configuration and a one-time app
  permission approval. A logged-in capture user can remain in the background.
  Per-simulator isolation and guaranteed lip-sync are not provided.
- Recording is silent. Its presentation orientation is captured at recording start;
  start another recording for another orientation. Static-screen capture can produce
  a shorter movie than elapsed recording time.
- Save/Discard/Cancel protects intentional session changes. Where File System Access
  is unavailable, browser fallback can confirm only that a download started, so the
  owning session stays open for an explicit Discard or Cancel. Crashes, forced access
  revocation and browser termination do not guarantee recovery of unsaved recordings.

## Validation before release

The recorded private regressions, Linux package checks and scoped Mac checks include
requested landscape input, a fully decoded real landscape recording, and real
simulator audio delivered to a client receiver. They do not establish audible client
playback or complete native acceptance. Windows runtime checks are blocked by the
absence of a test device. Native pickers and installed-client integration, actual
Homebrew replacement, external rotation, broader gestures, audible playback/output
changes, A/V skew and signed-helper permission persistence remain release checks.
The owner must review remaining gates or explicitly exclude claims before release;
merging code does not close those issues or authorize a release.

See [the upgrade guide](upgrading.md), [private validation policy](private-validation.md)
and [release acceptance ledger](release-acceptance.md) before publishing. This file describes unreleased
work; native behavior must not be inferred from build or injected-backend checks.
