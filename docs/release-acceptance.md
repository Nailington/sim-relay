# Release acceptance ledger

Issue #29 tracks runtime acceptance for the pending stack (#15 → #18 → #17 → #19 →
#16) and follow-ups #20–#31. The intended release is the next release after 0.1.5;
no version has been assigned. This ledger does not authorize publishing, merging,
or closing feature issues. A passing build is a build result, not native acceptance.

## Recording a result

Use exactly **passed**, **failed**, **blocked**, or **not run** for each case. A failed
case needs a tracked fix or an explicit exclusion from release claims. Blocked means
an identified prerequisite prevents execution; not run means no result was obtained.
Historical passes apply only to their recorded commit and environment. Repeat the
relevant cases after changes to that path, including the integrated release candidate.

A result must record the full app commit and displayed version, date, client OS and
browser/Electron version, Mac OS, Xcode, simulator runtime/device type, companion build,
steps and expected result, actual result, evidence location/digest, and cleanup result.
Use `not applicable` or `unknown (not recorded)` rather than guessing missing versions.
Keep runners, fixtures, raw logs/captures and secrets private under the
[validation policy](private-validation.md). Publish only reviewed, sanitized results.
A private report should identify the private suite revision/digest independently of
its application commit. A public checkout cannot reproduce a missing private bundle.

## Current evidence and scope

- **Passed — final integrated Linux implementation and packaging checks.** At
  `8a8b0db`, 186 private regressions, the production build, applicable built-app
  smokes, actual Linux payload/launcher checks and both Linux Nix packages pass.
  The review-found startup-retirement and Nix host-layout defects are fixed.
  [Candidate commit, suite digest, review dispositions and limits](validation-integrated-2026-10-25.md).

- **Passed — Linux foundation regressions, not native acceptance.** At integrated
  `0e2d049`, 148 private regressions, type-check/build and the actual built React,
  Chromium-account and Electron window-routing smokes passed. The independently
  reproduced HTTP-retirement race remains a failure at that checkpoint.
  [Environment, private-suite digest and qualification](validation-checkpoint-2026-10-25.md).

- **Passed — historical native session streaming and requested orientation metadata.**
  App source `cce368590f02c74eedb3b5d7d2222f11368d95fc` (version 0.1.5),
  2026-10-23; macOS 15.7.1, Xcode 26.0.1 (17A400), Node 24.16.0,
  iOS 26.0.1, companion build date Oct 22 2026. Two dedicated devices delivered
  183 frames each. Requested A rotation changed to 90°, B stayed at 0°, then A
  returned to 0°. This was direct production backend/gRPC work, without a desktop
  client or reconnection test. [Detailed evidence](native-session-validation.md).
- **Failed — representative app/AX readiness in that native session run.** Safari
  launch/openurl stalled, SpringBoard had unloaded icons, and AX reported no frontmost
  app during memory pressure. Devices were shut down. These failures prevented
  gesture/landscape hit-target acceptance; they were not fixed or rerun successfully.
- **Passed — historical native recording and pinned transfer.** Media implementation
  `1a7c7edb5d144b4f86e8e677a704df2c22b7f356` (version 0.1.5), macOS/Xcode/runtime
  as above; Linux x64 receiving client (OS distribution/version not recorded). Real
  SpringBoard interaction produced H.264 1206×2622, 92 frames, 10.038333 seconds,
  351107 bytes; complete decoding and pinned TLS download succeeded. SHA-256
  `f44cf4f601cba9db894fa6b4c6065ad808b72e28d74414543ed33c55c9920ea7`.
  This does not prove landscape playback, a native save picker, or audio sync.
  [Sanitized measurements](media-native-validation.json), [qualification](media.md).
- **Failed — historical audio permission probe; blocked — audible audio acceptance.**
  ScreenCaptureKit denied permission. No PCM was retained. The owner then instructed
  continuation without audio validation for that run. On October 26 the owner separately
  authorized unattended app-owned audio validation after one-time permission approval.
  That follow-up must record its own background-user and audible evidence; the historical
  probe does not prove it. See [audio setup](media.md).
- **Passed — limited historical stream measurements.** That media run received about
  29.79 FPS at 1206×2622 and 15 FPS at 604×1312. A production bandwidth-budget setting
  reduced resolution/FPS. This was not a shaped WAN test, measured video latency,
  input-to-photon measurement, or a representative scrolling/readability assessment.
- **Passed — implementation-level Linux packaging checks for #22/#25.** PR #33 at
  `645af7fe597b5678b0899411f8170406306c754b` reports actual unpacked Electron payload
  exclusion, launch from `/`, SIGTERM/restart/HTTPS, Nix desktop/web x86_64 builds,
  all-system evaluation/source exclusions, and an ephemeral systemd user-service
  LoadCredential/restart/status/log check. No native Homebrew upgrade, launchd login,
  signed Mac install, Windows runtime or full NixOS switch was tested. Preserve those
  distinctions when carrying the evidence into a release report.
- **Blocked — further Mac runtime checks in this environment.** The reusable SSH
  connection expired and unattended authentication returned Permission denied.
  Restored authorized access and a usable GUI session are prerequisites for follow-up;
  no SSH credential or permission change is implied by this ledger.

## Required cases for the integrated candidate

### Orientation, rendering and gestures — not run

Use one dedicated simulator and a known landscape-capable app with visible corner
hit targets. Record portrait, landscape-left/right and upside-down where supported;
rotate both through the client and Simulator.app. Verify upright content, aspect ratio,
pointer/touch coordinates, text input, drag/hold, scroll and pinch at each orientation.
Repeat at reduced stream resolution and display scaling. Log whether companion
orientation metadata is available; requested rotation alone cannot establish external
rotation. Record readable screenshots and target outcomes privately. Related: #1, #3,
#6, #8, #18. The earlier Safari/AX failure remains unresolved for this acceptance case.

### Recovery, input release and device lifetime — not run

While holding a key/contact, interrupt the actual network, restart the host, and
sleep/wake the Mac in separate runs. Verify released input, bounded status/retry,
Cancel stopping retries, explicit reconnect after terminal access denial, and no boot
of an intentionally shut-down simulator. Repeat disconnect/pop-out/return and workspace
close/reopen with independent devices. Record actual transport timing, process ownership
and final device state. Injected socket tests are separate evidence. Related: #18, #20,
#21, #27, #28.

### Desktop platforms and OS integration — not run

On supported macOS and Windows versions, install the produced candidate, verify its
version/signature, open two displays, use multiple monitors and fullscreen, close/reopen
the workspace, and use real screenshot/install/recording open/save dialogs. Confirm
correct dialog parent and Cancel behavior. Restart the app to verify OS-protected
credential storage; test unavailable storage without persisting plaintext. Record OS,
architecture, display arrangement, installer digest and secure-storage backend.
Linux headless Electron driver results cannot satisfy these cases. Related: #7, #10,
#12, #18, #24, #31.

### Browser, touch, account and downloads — not run

For each supported browser/version and a real touch device, log in, pair, obtain an
owner grant, connect, type/gesture, block then allow a popup, pop out and return using
the documented explicit reconnect. Exercise account switching and reset in sibling
tabs. Save a real recording through File System Access where supported and the native
browser download fallback elsewhere; cancel pickers and interrupt transfer. Confirm
fallback only reports download started and retains the owning session until explicit
Discard/Cancel. Browser fixtures with injected sinks/MP4 bytes are not native download
completion evidence. Related: #5, #16, #24, #26, #28, #30.

### Packaged audio helper — partially verified

The owner authorized a follow-up and approved the app helper on October 26. Real tone
capture, authenticated delivery, restart and owner-crash cleanup passed over SSH with
the capture user logged in in the background. See [the native report](audio-headless-validation.md).
This used an ad-hoc development candidate and synthetic video session, without replacing
the installed app. The signed/notarized release still needs identity, entitlements and
permission-persistence validation. Use an owned audible fixture, explicit host-wide consent and local opt-in.
Measure audible playback, mute/volume, output-device changes, disconnect cleanup and
flash/click A/V skew. Test denied permission separately without changing TCC policy.
Do not claim per-simulator audio isolation or guaranteed lip-sync. SSH/MDM research is
not a permission grant. Related: #11, #13, #19.

### Constrained-network responsiveness — not run

Apply and record actual bandwidth, delay, jitter and loss on an owned test route.
Use representative text, scrolling and gestures at fixed and adaptive quality. Report
readability, delivered FPS, bitrate and measured frame/input-to-photon latency with
measurement method. Label control ping RTT separately. Include cancellation and
recovery without replaying non-idempotent commands. Synthetic JPEG/H.264 size comparisons
and an internal bitrate budget do not establish WAN performance. Related: #6, #19, #26.

### Recording lifecycle and data loss — partly passed historically; candidate not run

Record representative portrait and landscape app interaction; save through each real
client, play and completely decode the MP4, and compare expected orientation/duration.
Exercise Save/Discard/Cancel during target changes, disconnect, pop-out/return, shutdown,
window close and quit. Cancel must preserve target, FPS, active/ready recording and
transport. Confirm desktop ownership transfers retain capture. Interrupt a save and
revoke/edit scope during a backpressured download; verify no success claim and cleanup
of owned files/processes. Socket-bound host tickets have no retention grace. Confirm
ordinary disconnect and forced revocation delete unsaved host recordings. Related:
#19, #24, #28.

### Host service, keep-awake and upgrades — not run natively

From the packaged Mac app and CLI, select the same configuration, start/stop/restart,
rotate/copy the current code and review/revoke/grant clients. Test real login/logout
with start-at-login enabled and disabled independently of current running state.
With keep-awake off/on, inspect the owned assertion during active sessions and after
all cleanup paths, including failed connections; display sleep remains separate.
Run a real Homebrew upgrade from a prior installed version with both running/stopped
host states. Require observed retirement of sockets, HTTP handlers, child processes,
recordings and sleep assertions before package replacement. Verify preserved certificate,
client grants, selected config/login policy and restart only after successful install.
Exercise prepare/install/resume failures without success acknowledgment or unintended
restart. Historical 0.1.5 installations lack the new wrapper; follow the documented
migration. Related: #20–#22, #25, #27, #28.

### Authorization, migration, routes and private publication — candidate pending

Update clients first, upgrade a legacy host, verify the existing certificate fingerprint,
re-pair every intended client, then grant permissions locally. Distinguish wrong code,
revoked identity, legacy pairing and owner-denied access. Test viewer versus controller,
explicit device lists and each optional action from desktop and browser. Permission
changes must terminate active transports/downloads and invalidate pending dispatch.
For route fallback, try unreachable and wrong-certificate aliases before a valid route;
verify no credentials reach an unverified certificate and actions dispatch once.
Inspect the actual candidate installers and evaluated Nix sources for private paths;
check a fresh public checkout builds without the private suite. Record the private
suite digest/report separately from public build CI. Related: #22, #26, #28, #30, #31.

## Release decision

No native acceptance gate above is waived by code being implemented or a PR becoming
ready for review. Keep related issues open until their own acceptance criteria are
met. Before release, attach a candidate-specific sanitized report, list any explicitly
excluded platforms/features in release notes, and obtain the owner's final review.
