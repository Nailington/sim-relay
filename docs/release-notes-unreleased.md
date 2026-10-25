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

See [the upgrade guide](upgrading.md), [private validation policy](private-validation.md)
and release acceptance evidence before publishing. This file describes unreleased
work; native behavior must not be inferred from build or injected-backend checks.
