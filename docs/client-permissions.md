# Client permissions

The Mac owner controls client access through the local administrator socket in the
host's private state directory. Network clients cannot administer permissions.
Desktop and browser connections use the same HTTPS/WSS checks on the Mac.

## Pairing and migration

Newly paired clients are viewers with an empty device allowlist and every optional
capability disabled. Pairing establishes an identity; the owner must then grant
access. An empty list means no simulators. `devices: "all"` explicitly includes
current and future devices; a UUID array includes only those device identities,
regardless of UUID letter case. Device names and the `booted` alias never grant access.

Existing `clients.json` version 1 records migrate once to version 2 with explicit
controller/all-device permissions and all optional capabilities enabled. Only
records already present receive that compatibility grant. Newly paired records
never inherit it. A legacy shared pairing token still does not authenticate as a
client. Broken version 2 permissions fail startup rather than falling back to
broad defaults. Tokens remain hashed on disk and never appear in client listings.

## Role and optional capabilities

Viewers can stream a permitted, already booted simulator. They cannot send input,
boot/shut down/create simulators, install apps, or issue simctl commands, even when
optional management flags are enabled. Controllers can send input and use the
typed device controls. Creating a simulator requires controller access to `all`
devices because a new device does not yet have an allowlisted UUID.

Screenshots (`screenshots`) and video recording (`recordings`) are independent
capture grants, available to either role for allowed devices. A video recording
and its download ticket belong to the authenticated client and device that
created it; another client's credential cannot redeem the ticket. Revocation or
any permission edit invalidates live downloads and discards the session's recording.
Already downloaded content cannot be recalled.

Host audio (`hostAudio`) is an explicit, independent grant. It includes playback
from every app on the Mac, including content outside the device allowlist. It
also requires the host owner's audio setting, a supported capture helper, and
client confirmation of host-wide capture. Device scope never implies audio consent.

App installation requires `installation` and controller access to the device;
archives must use the upload endpoint. Destructive raw operations require
`destructive` as well as `rawSimctl`. Uninstall requires installation, destructive,
and raw permissions. Erase/delete still require per-command confirmation.

## Raw commands and host paths

`rawSimctl` enables an audited subset of simctl for controllers, with an explicit
allowed UUID as the second argument. It never grants arbitrary host execution or
file access, even to migrated all-device clients. Supported forms are:

- `boot UUID`, `shutdown UUID`, `bootstatus UUID [-b]`
- `erase UUID`, `delete UUID` (destructive grant and confirmation)
- `launch UUID BUNDLE_ID`, `terminate UUID BUNDLE_ID`, `appinfo UUID BUNDLE_ID`, `listapps UUID`
- `uninstall UUID BUNDLE_ID` (installation and destructive grants)
- `ui UUID appearance light|dark`
- `location UUID clear`, `location UUID set LATITUDE,LONGITUDE`
- `openurl UUID URL` (no file URLs)

All other subcommands, extra options, `all`/`booted` aliases, global runtime/device
set operations, spawn, clone/pair, raw install/addmedia, file output arguments,
and host-path inputs are rejected. Use filtered `/devices` for inventory, the
screenshot endpoint for PNG bytes, and the upload endpoint for installation.
These restrictions also apply to existing clients: unrestricted simctl cannot be
reconciled with independent device/action grants or host-file isolation.

## Display ownership and changes in access

One active display, either viewer or controller, may hold a simulator at a time.
Different permitted devices can stream concurrently. Concurrent viewers alongside
a controller are not supported: the current backend owns a companion, video
configuration, and pressed-input lifetime per display. Opening separate companions
would risk conflicting input release and quality changes. A future shared capture
broker can add fan-out without duplicating ownership.

Permission edits invalidate existing requests and close all that client's displays
with code 4004 (`permission_denied`). The credential stays valid; reconnect with
the current grant. Revocation closes displays with code 4003 and rejects the
credential (`authorization_required`). Cleanup is bounded for local administration;
a device lease remains occupied until its previous backend actually closes.
Failed cleanup makes host shutdown fail, preventing a false successful retirement.

Requests and media recheck client identity, permission revision, capability, and
device scope after asynchronous preparation and before backend dispatch. Edits
invalidate transports before filesystem I/O. New grants publish only after the
save succeeds. A failed save disconnects previous sessions and leaves the previous
grant in place; refresh before retrying. Already dispatched simctl processes receive
an abort signal, and subsequent commands and response bytes are blocked. Completed
side effects cannot be undone by revocation. A custom backend must honor the
optional `run`/`session` abort signal to cancel its own pending work.

## Administrator and GUI contract

`src/shared/permissions.ts` exports the strict `clientPermissionsSchema` and
`ClientPermissions` type. All fields are required:

```json
{
  "role": "viewer",
  "devices": ["218F5525-50CF-4313-8F44-D58D64811D38"],
  "installation": false,
  "destructive": false,
  "rawSimctl": false,
  "screenshots": true,
  "recordings": false,
  "hostAudio": false
}
```

Local admin `{ "action": "list" }` returns each client's identity, timestamps,
`activeSessions`, `permissions`, and `permissionRevision`. Never infer a grant from
omitted fields. Save a full replacement using:

```json
{
  "action": "permissions",
  "id": "CLIENT_UUID",
  "expectedRevision": 0,
  "permissions": { "...": "all fields shown above" }
}
```

The revision is a compare-and-swap guard. A stale revision fails without mutation;
refresh and let the owner review the new value. Successful saves return the full
updated client, including its new revision. Do not blindly retry a stale edit or
merge checkboxes with permissive defaults. A lost response also requires refresh.
`revoke` and `pairing` retain their existing local-only contracts.

The coordinated host-management CLI exposes `permissions CLIENT_ID` to inspect,
and `permissions CLIENT_ID EXPECTED_REVISION JSON` to replace permissions. Its GUI
uses the same full-replacement contract. Those controls are supplied by the
host-management implementation alongside this host enforcement change.

Authenticated `GET /permissions` returns `{permissions, permissionRevision}` for
the requesting client; it remains usable with an empty device allowlist. Clients
should show that a newly paired identity awaits an access grant from the Mac owner.
HTTP 403 is `{code:"permission_denied", error:"..."}` and must never prompt re-pairing.
Invalid credentials use HTTP 401 `{code:"authorization_required", error:"..."}`;
invalid/consumed pairing codes use HTTP 401 `pairing_code_invalid`.
WSS denied upgrades return HTTP 403 JSON; permission-denied input/media actions
carry `code:"permission_denied"`. A live permission edit sends an error notice and
closes with 4004. A revocation notice uses `authorization_required` and closes with 4003.

Local `status` returns `HostStatus` without its token, plus `pid`, `mode`
(`foreground` or `background`), and `keepAwake`. Local
`{action:"keep-awake",enabled:boolean}` persists and returns the policy snapshot.
Only successfully opened backend sessions count as active; closing them releases
the assertion. Keep-awake shutdown completes before successful host retirement.
