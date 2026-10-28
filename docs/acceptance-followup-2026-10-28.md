# Acceptance follow-up — October 26–28, 2026

Validated production source commit: `1a898d79f8021d2c732b0a9ceb5d0e1fd326f05b` (version 0.1.5, unreleased).
Private suite manifest SHA-256: `c9d247b2a9ed408fa9f9f92cd83ee3f60f82c7af554d4fb05893ed7a27ae702d`.
The manifest hashes sorted relative suite paths and each file digest as canonical JSON.
An owner-only archive outside public Git preserves that suite and manifest. Tests,
runners, credentials, raw frames, movies and logs remain private.

## Fixed implementation problems

- Focus loss previously left finite gestures queued behind an active RPC. A reproduction
  opened ten swipe RPCs, including nine after release. The bounded dispatcher now drops
  unsent RPCs on cancellation and preserves the active gesture's contact/key releases.
  The same reproduction opens one RPC and zero after release. Queue admission is bounded
  to 16 operations and 2,000 unsent events. Rejected input preserves held state; rejected
  admission cannot leave an empty unfinished RPC.
- A canceled queued rotation could falsely publish a rotated display. Requested orientation
  is now published when its HID RPC starts, so cancellation cannot leave metadata claiming
  a rotation that was never dispatched. Private regressions cover both paths.
- A real landscape recording exposed simctl's portrait canvas without presentation metadata.
  Finalization now snapshots the host's display presentation at recording start and writes
  the video track's QuickTime transform before issuing a download ticket. It does not
  re-encode samples, change timestamps or require FFmpeg at runtime. Existing transforms
  are preserved; already matching canvas aspect is not rotated again. Rotation is fixed
  at recording start, not dynamically updated through the movie.
- Workspace gesture help now exposes unavailable external-orientation reporting, matching
  pop-outs. Browser media documentation now describes the implemented authenticated relay
  and its actual download-completion limits.

An independent review reproduced the queue saturation and canceled-rotation edge cases;
those findings were fixed and have private regressions. Review found no concrete defect
in the bounded MP4 parser, transform writes, ticket ordering or cleanup integration.
No separate independent approval of the final small follow-up patches is claimed.

## Passed implementation and packaging checks

On Linux x64, Node 24.21.0 and Electron 45.0.0:

- All **248 private regressions passed**, with zero failures or skips; TypeScript and the
  complete production build passed.
- The built React workspace smoke and final built Electron session/recording-ownership
  smoke passed. These use injected hosts/pickers and are not native OS-dialog evidence.
- Both Nix x86_64 Linux production packages rebuilt successfully; their actual evaluated
  source trees exclude private assets and include the recording finalizer. This does not
  establish a full NixOS system deployment.
- The actual unpacked Linux application passed the published payload check: no project
  tests, fixtures, runners or private evidence in its archive/resources, and the browser
  bundle/launcher are present.
- The production MP4 finalizer passed 26 private parser/transform cases. Copies of the real
  native recording decoded with all three rotations, matched explicit FFmpeg pixel
  transforms, retained identical encoded `mdat` bytes and unchanged file size.

## Passed native checks and their scope

Native environment: macOS 15.7.1, Xcode 26.0.1 (17A400), iPhone 17 Pro simulator runtime
identifier `com.apple.CoreSimulator.SimRuntime.iOS-26-0`, Homebrew idb-companion 1.7.7.
The isolated host runners used Electron 45.0.0 / Node 24.22.0 / Chromium 156.0.8078.48 as
an executable runtime; they did not replace the installed application. The capture/SSH
user remained logged in in the background while a different user owned the display.

### Host lifecycle, authorization and power — October 26

At the #40 foundation, real launchd plus the production service manager, pinned TLS/WSS
and local administration passed start/status, duplicate-start PID preservation, fresh
pairing-code rotation, masked status, viewer scope/input denial, two-client revocation
isolation, restart retirement acknowledgments, upgrade prepare/resume, retained identity
and client credentials, and keeping a previously stopped host stopped. The simulator
backend was synthetic. A unique validation label and private home/state isolated the
run from the owner's service. No job or daemon remained; launchd may retain an enabled
override for that unused unique label. This is not a Homebrew/app-replacement, actual
login/logout, GUI or Keychain acceptance pass.

The production keep-awake module acquired a real `PreventUserIdleSystemSleep` assertion,
released it after the last session and when disabled, retained its opt-in across reload,
and left zero owned caffeinate processes. No display-wake assertion or actual sleep/wake
experiment was performed. These service/power modules were unchanged by the later fixes.

### Live app, rotated input, audio and recording — October 28

Only one dedicated validation simulator was used. The previously stalled owned media app
launched successfully and its accessibility controls were readable. Safari also launched
and yielded a readable XCTest accessibility snapshot during the October 26 retry; this
is not a claim that all idb accessibility APIs work for remote web content.

- At the input-fix checkpoint `e4676db39888c70e6dea4737e7c2fd6fc40f8b92`, production pinned WSS
  input toggled the real fixture button in portrait and both requested landscape directions
  at half stream resolution. Native bounds and button-state changes established the hits.
  The orientation source remained unavailable for external changes on this companion.
- The owned simulator app's quiet 880 Hz pulse passed through the real native backend,
  approved app-owned Core Audio capture, authenticated pinned WSS and a Linux receiving
  ClientMedia instance over an owned SSH forward. The client received 451 audio packets
  and 122 native video frames; PCM peak was 83 and the measured tone component matched
  880 Hz. Audio was processed in memory and discarded. This checks real simulator audio
  delivery, not an actual decoder/speaker, mute/volume, output switching or A/V skew.
  The audio path is unchanged by the final recording/rotation-metadata fixes.
- A fresh run of the final source snapshot requested landscape, recorded, saved through
  production pinned HTTPS, restored portrait, and retired the host successfully. The
  movie is H.264, 24 frames, 2.531667 seconds, 73,133 bytes; its raw canvas is 1206×2622,
  with a -90° FFmpeg display-matrix reading (90° clockwise presentation). Automatic
  presentation yields **2622×1206 upright landscape**, and full decode passed.
  SHA-256: `087b720c92f49c0bd744bbdc457467dc46e0707dab731e24dc866f014b9153b7`.
  Static frames can make the movie duration shorter than elapsed capture time.

The dedicated device was restored and confirmed shut down. Owned hosts, companions,
capture and forwarding processes retired; control sockets, live state directories and
the temporary client credential were removed. The installed application, actual host
service, other simulators, TCC policy and global output device/volume were not changed.

### Actual shaped encrypted connection — October 26

A transparent owned TCP proxy limited real TLS/WSS bytes to 1 Mbps in each direction
with a minimum 30 ms one-way delay. It replayed an owned historical native SpringBoard
JPEG through production host/adaptation/ClientMedia, using FFmpeg-prepared image tiers:

- Manual: 46 received frames in 18 seconds, 2.56 receipt FPS, 990 kbps video payload.
- Automatic: 122 frames in 18 seconds, 6.78 receipt FPS, 840 kbps; final limits were
  8 FPS, scale 0.4 and quality 0.4.
- Proxy queue peaks were 94,947 and 103,738 bytes, below the 196,608-byte cap; no arbitrary
  TLS bytes were dropped. OS kernel queues were not measured.
- The after-10-second median fixture production-to-receipt age was 1238 ms versus 82 ms,
  but automatic p95 was still 1224 ms including ramp backlog. This is not a latency
  guarantee or a steady-state native capture measurement.

Receipt acknowledgments used synthetic zero decode time. No actual decoder, human text
readability, live simulator responsiveness, WAN or input-to-photon result is claimed.
The adaptation implementation was unchanged by the later acceptance fixes.

## Publication and remaining gates

PR descriptions #15/#17/#16/#19/#33 were refreshed. The automatic closing reference in
#15 was removed; all current open PR descriptions were checked for closing keywords.
The original review layers remain unmerged. Use the [production-only delivery path](production-delivery.md)
to avoid importing their test-containing feature history into main. This does not retract
historically exposed main/branch commits, PR refs, forks or downloads.

The following remain **blocked** or **not run**, not implicit passes:

- Windows native acceptance is blocked: the owner has no Windows test device ready.
- External Simulator.app rotation is not accepted on the installed companion; requested
  rotation works, but no unsupported orientation inference was added. Modern companion
  reporting, portrait-locked/upside-down apps, representative pinch/drag/text and native
  interruption/sleep/wake still need their own cases.
- Native OS pickers, installed macOS/Windows windows and multiple monitors, secure storage,
  real touch hardware/browser downloads, actual Homebrew replacement, full NixOS deployment,
  signed/notarized update permission persistence, audible client playback/output changes
  and flash/click sync remain separate release checks.
- One exclusive display lease per simulator and discrete pinch/no arbitrary-contact twist
  are the documented contracts. The relevant issues ask for an explicit policy and feasible
  capability assessment; those limits are not mislabeled as test passes or implemented fan-out.

Keep issues open until their own remaining criteria are met. Nothing was merged, released
or installed by this follow-up.
