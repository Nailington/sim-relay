# Protecting unsaved recordings

An intentional action that would end a recording session asks the recording owner to
**Save recording**, **Discard recording**, or **Cancel**. This includes changing the
simulator/Mac/FPS, disconnecting, forgetting or re-pairing a Mac, changing an active
connection address, destructive simulator actions, browser popup/return, sign-out,
workspace reset, and desktop close/quit. Cancel retains the existing selection,
recording and transport. Adding an unused verified address does not end capture.

Save stops and finalizes capture before writing the MP4. Continuation requires a
confirmed completed file write; picker cancellation or a save failure keeps the
session and decision available. Browser download fallback cannot observe native
browser download completion: it reports only download started, retains the Mac's
copy and does not authorize the pending session change. Check the download, then
explicitly Discard to continue, or Cancel to keep the session. Whole-file Blob
buffering is not used.

Desktop pop-out/return transfers the existing transport and capture, so it needs no
loss prompt. Desktop stop/restart-host and destructive actions check every affected
local display owner, not only the initiating window. One Cancel prevents the action;
a previous owner's already completed save/discard is not undone. A late-created
unsaved owner also prevents cleanup. Remote clients and CLI-driven shutdown cannot
receive a local renderer confirmation; save recordings before external host upgrades,
service stops or permission changes.

Forced revocation, permission edits, account expiry/invalidation, renderer death and
security disposal never wait for a recording dialog. They cancel pending decisions
and immediately perform their normal cleanup. The host recording/ticket remains
socket-bound, with no retention grace after disconnect. Already saved files cannot
be recalled. Browser unload warnings are best effort and cannot run an asynchronous
save during tab/browser termination. Hiding a browser tab releases held input while
keeping its transport alive, so file pickers and tab switches do not discard capture.

Private validation uses the built React workspace and real Electron windows with
injected media/filesystem/backend fixtures. It checks fallback save, confirmed-write
ordering, selection/FPS cancellation, finalization, failure, nested dialogs/Escape,
browser transfer, desktop transfer exemptions, native close/quit, sign-out/reset and
all-local-owner stop/restart. Route/re-pair cancellation is also exercised against
real loopback TLS/WSS transport. These checks do not prove native OS picker behavior,
real browser download completion or real simulator MP4 playback. See the
[release acceptance ledger](release-acceptance.md) for those gates and the
[private validation policy](private-validation.md) for source handling.
