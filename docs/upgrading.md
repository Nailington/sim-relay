# Updating Sim Relay and protocol 2 pairing

Open **Updates** in the workspace to check the current client/browser service version,
latest release, release notes and installation-specific instructions. Automatic checks
are off until enabled; the daily preference stays on this device/browser account.
Checks read public GitHub metadata without Mac addresses or credentials, use bounded
requests and preserve normal app operation when offline or rate limited. Preview
releases are opt-in; SemVer ordering never offers a downgrade or build-metadata-only
change. A release missing an installer for this OS/architecture is identified instead
of being presented as installable. Nix users update source pins through Nix.

The paired Mac has a separate version and protocol. The Updates panel retrieves that
information independently. Updating a desktop client does not update a remote Mac.
A browser workspace runs the hosting service's installed version; after that service
is upgraded, reload the page to receive the updated frontend.

## Upgrade order

1. Save recordings and stop captures before any host or browser-service restart.
2. Update clients first. Current clients support protocol 1 and protocol 2; released
   clients using only the old shared-token flow cannot operate a protocol 2 host.
3. Upgrade the Mac host through its original installation channel. Homebrew users
   use `sim-relay-upgrade` when provided by the installed release; this coordinated
   wrapper stops a running background host before replacing its runtime, preserves
   saved settings, and resumes only a previously running host after a successful
   upgrade. The historical 0.1.5 package does not contain that command: stop the
   background host with `sim-relay-host stop`, upgrade the cask, then start the new
   host if it was previously running. Preserve a private record of custom settings
   when upgrading from a release without coordinated handoff. Do not replace runtime
   files while a host is actively capturing. Nix users update their flake input and
   rebuild the profile/system; installer users stop the host before replacing the app.
4. Keep the existing host state directory, certificate/key and simulator data.
   Restart the background host from the upgraded installed executable. Expect client
   disconnection and bounded reconnect attempts during the interruption. Do not
   enable sharing on a host that was stopped just to finish an upgrade.
5. After the first protocol 2 host upgrade, pair each device/browser again. The host
   invalidates its old shared token and issues separate client credentials. Obtain
   the **current** single-use code in **Share this Mac**, or run
   `sim-relay-host pairing` for the selected background instance. A successful pairing
   consumes the code; refresh it for the next client.
6. Compare the host certificate fingerprint in the pairing dialog with the Mac.
   Upgrading authorization does not require replacing the certificate. If it differs,
   investigate and explicitly verify the new fingerprint before pairing. No fallback
   or recovery step silently updates a saved certificate pin.
7. New least-privilege pairings may await the Mac owner's device/action grant in
   **Authorized clients**. Successful pairing proves client identity, not permission
   to operate every simulator.

## Recover without deleting state

- **Old shared pairing:** a saved protocol 1 credential no longer authorizes the
  upgraded host. Choose **Pair again**, retain the saved Mac identity, verify the
  fingerprint, and exchange the current single-use code. The client uses saved mode
  and known legacy credential format only to explain recovery; the host always
  decides authorization.
- **Incorrect or used pairing code:** fetch the current code rather than retrying a
  screenshot of startup output. A protocol 1 host still uses its shared code and does
  not rotate it after pairing; the error explains that distinction.
- **Access revoked/invalid:** ask the Mac owner whether access should be restored.
  An active revocation stops streams and pending actions. Re-pair only if approved.
  A generic invalid credential cannot prove exactly why access was removed.
- **Permission denied:** ask the owner to grant the simulator/action. Re-pairing does
  not expand permissions. Scope changes stop existing sessions; reconnect after the
  owner saves the new grant.
- **Certificate mismatch:** verify the host identity separately. Do not delete arbitrary
  files, replace the pin automatically or send credentials to an unverified endpoint.
- **Unsupported protocol:** update an old client before pairing with a newer host.
  If the host uses an unsupported older protocol, update that host too. Current
  clients can continue using known protocol 1 hosts with shared-token limitations.

An old client may surface the host's HTTP authorization guidance, but its compiled
error UI cannot be retroactively changed. This guide and the release notes provide
recovery when the old app only shows a generic connection failure.
