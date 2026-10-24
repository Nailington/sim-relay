# Streaming, recording, and Mac audio

Media uses the existing authenticated, certificate-pinned HTTPS/WSS connection. No raw UDP,
unauthenticated media port, microphone capture, or host-volume manipulation is introduced.
The automated tests use injected capture backends. Real Apple Silicon simulator video, recording,
Linux client download, and cleanup have also been verified as described below. **Audio capture
remains blocked by macOS TCC and was not validated with a representative simulator app.**
Keep #8, #12, and #13 open until their remaining acceptance checks are completed.

## Adaptive display (#8)

The compatible display codec remains MJPEG. The host changes idb's `fps`, `scaleFactor`, and
`compressionQuality` by restarting only the video RPC, leaving HID connected. Scaled encoded
pixels never change the native point coordinates used for input. Each simulator controller
has independent quality state. Reconfiguration may briefly interrupt video; old RPC callbacks
are ignored. This uses the existing wire fields, avoiding newer, potentially unsupported idb
bitrate fields.

Automatic mode starts at the selected FPS/full resolution/JPEG 70%, with a 12 Mbps video
limit. Every two seconds, >18% host drops, slow decoding, or >15% client drops reduce capture
through five tiers (100/85/70/55/40% resolution, FPS multipliers 1/.8/.6/.4/.25, quality ceilings
90/70/60/50/40%). Four healthy samples are needed to recover one tier. Manual mode fixes the
capture settings. Both modes honor maximum FPS/resolution/JPEG quality and a byte token bucket.
The bandwidth limit is for video payloads, not TLS/IP overhead, recordings, or audio. It is a
long-run budget with a bounded frame burst, not an instantaneous network-rate guarantee.

Obsolete frames are dropped, never held for later playback. A host socket stops accepting video
above a bandwidth-relative backlog (at most 256 KiB). Individual JPEGs above a bandwidth-relative
frame bound (64 KiB–2 MiB) are dropped, causing automatic mode to reduce capture cost. The desktop
bridge keeps one IPC frame in flight and one latest replacement; preload acknowledges after
the decoder's promise settles. Hidden/unresponsive renderers cannot build an IPC video queue.
The decoder retains no history and closes every ImageBitmap. Inputs share the authenticated
socket but are not queued behind a server-side video FIFO. TCP head-of-line delay still exists;
this is not WebRTC congestion control.

The inspector reports measured video payload Mbps, sent/decoded FPS, host drops per sample,
mean client decode time, and a measured control round trip. The round trip is **not** video
latency. Neither capture-to-display latency nor input-to-photon latency is currently measured.
Main-process replacement drops are included in client feedback. Capture settings are requests
to idb; an old companion that ignores scale/quality can still be bounded by frame dropping but
may require upgrading to get useful low-bandwidth video. Choose full resolution/manual quality
when small text needs inspection; reduced quality cannot guarantee identical text readability.

### Codec assessment and reproducible experiment

- MJPEG: independently decodable frames, supported by `createImageBitmap` on the Electron
  macOS/Windows/Linux clients and common browsers. High bandwidth and repeated JPEG decode cost;
  independently dropping frames is straightforward. This remains the fallback.
- H.264: idb exposes an Annex-B H.264 format; macOS VideoToolbox offers hardware acceleration
  depending on the machine/encoder. Recording uses simctl's H.264 encoder, but the live path
  would additionally need access-unit parsing, SPS/PPS configuration, keyframe recovery,
  timestamping, and runtime `VideoDecoder.isConfigSupported` checks. WebCodecs does not require
  any particular codec; browser/OS builds (especially Linux) differ. Hardware decoding must be
  measured on each supported Electron package, rather than inferred from OS name.
- WebRTC: offers media clocks, jitter/congestion handling, Opus, and DTLS-SRTP, but needs a
  native capture/encoder/peer bridge and authenticated signaling, plus TURN configuration for
  NAT traversal. Node's `ws`/idb payloads cannot simply be forwarded as WebRTC tracks. Adding
  that native dependency and packaging/signing work is substantially larger than adaptive
  MJPEG. No WebRTC or live H.264 compatibility is advertised by this implementation.
- Browser client: JPEG and Web Audio PCM are practical decoding fallbacks, but this host still
  rejects browser Origins. A browser client needs the separate authenticated hosting work in
  #5. Its download flow should stream the same recording asset rather than collecting a large Blob.

Run `npm run benchmark:media` with FFmpeg installed. The script renders a deterministic scrolling
1170×2532 Settings-like UI (90 frames/3 seconds), encodes JPEG tiers and software libx264, compares
SSIM after scaling back to source size, then feeds those actual frame sizes to a 60-second
deterministic network model using the production adaptive controller. It deletes all temporary
media. FFmpeg is an external experiment tool, not a runtime dependency or bundled codec.

On Linux x64 with FFmpeg 9.0.2, measured full-size MJPEG was 33.80 Mbps at SSIM .995727;
40% MJPEG was 5.75 Mbps at SSIM .966781. Software libx264 CRF 23/veryfast/zerolatency was
0.461 Mbps at SSIM .999038. Those are **synthetic source/encoder results**, not simulator
measurements, and FFmpeg qscale is not idb compressionQuality. SSIM does not establish
text readability. The large H.264 benefit on this simple scrolling source motivates a future
native/WebCodecs implementation but does not establish hardware acceleration or codec availability.

In the network model, a 100 Mbps/4 ms RTT link delivered 30 FPS in both modes (13.6 ms estimated
95th-percentile transport queue + one-way delay). At 2 Mbps/80 ms RTT, the old 2 MiB backlog
policy reached 2,246,062 queued bytes, 2.03 sent FPS and 8,999 ms estimated p95 delivery delay.
The adaptive policy reached 122,203 queued bytes, 7.30 sent FPS, 1.54 Mbps payload and 354 ms
estimated p95 delay, ending at 8 FPS/40%/JPEG 40%. These are model estimates, including a
constant RTT assumption and no packet loss/TCP retransmissions; they are not measured
interaction responsiveness. The raw reproducible output is in [media-benchmark.json](media-benchmark.json).

## Screen recording (#12)

Capture happens on the host for the selected simulator UDID, using
`xcrun simctl io UDID recordVideo --codec=h264 --force screen.mp4`. It records the native
simulator display independently of network stream quality. The recording is **silent**;
enabling Mac audio playback does not add audio to the MP4. No desktop screen-recording
permission is needed for simctl framebuffer recording. Xcode/the selected runtime must support it.
This adds encoder/disk load to the Mac; it does not consume client CPU for encoding.

The inspector provides Record, a visible recording indicator/elapsed duration, Stop, Save MP4,
and Discard. Start waits for simctl's recording-started diagnostic (15-second timeout). Stop
uses SIGINT/pipe EOF so simctl writes its movie index. Finalization checks file size and MP4
top-level `ftyp`, `mdat`, and `moov` atoms before offering a download. This detects missing or
truncated indexes, not arbitrary media corruption; native playback validation remains necessary.
Finalization allows simctl up to 30 seconds to finish (35-second parent deadline; recording
RPCs allow 65 seconds). Bounded stderr is retained throughout, so encoder/finalization errors
remain actionable. Audio shutdown retains its separate eight-second bound. Finalization and
transfer have separate progress/error states. Save uses the client's native
save dialog and a pinned authenticated HTTPS stream to an adjacent `.partial-UUID` file;
only a complete transfer atomically replaces the chosen destination. Cancellation/failure removes
the partial file and keeps the host asset available for another Save attempt while connected.
Successful transfer explicitly discards the host asset. Canceling the save dialog preserves it.

Each websocket owns at most one recording; another client cannot start/stop/discard it through
its own socket. Downloads additionally require an unpredictable in-memory recording ticket as
`X-Recording-Ticket` and the host credential. Tickets never appear in URLs. Closing the display,
disconnecting, revocation (when supported by the authorization layer), or stopping the host aborts
capture and removes its directory. A small Node supervisor stops its owned simctl process on
host-pipe EOF, including host SIGKILL; escalation kills an encoder that refuses to stop. Capture
auto-finalizes at roughly 29 minutes or 1 GiB (checked once/second; size may overshoot briefly).
Ready recordings expire after ten minutes. Old crash directories under the host state's
`recordings/capture-*` are removed on startup once older than an hour. Normal shutdown awaits
capture cleanup. Whole-machine power loss can leave files until that cleanup; killing the
client during the filesystem rename/cleanup can leave a recognizable `.partial-*` file beside
the chosen destination. It can be removed manually; it never replaces the old destination.

simctl chooses the recording canvas at start. Orientation changes may be letterboxed/cropped or
retain that canvas depending on Xcode/runtime; the live display can still rotate independently.
For a recording intended for another orientation, rotate first, then start a new recording.
Do not promise dynamically resized movie tracks. One recording per session is supported; multiple
simulators use distinct processes/files but share the Mac's encoder capacity. Moving a display
by disconnect/reconnect discards unsaved recordings; UI reparenting that preserves the socket
must also preserve its ClientMedia owner.

## Mac audio (#13)

The supported implementation path is a bundled Swift **ScreenCaptureKit** helper on macOS 13+,
capturing the logged-in Mac desktop's system playback mix. This can carry simulator app sounds
without modifying the simulator app, installing a virtual audio driver, or intercepting its APIs.
**It includes all other Mac apps and simulators and is not isolated per UDID.** A host owner must
opt in locally with `SIM_RELAY_ENABLE_HOST_AUDIO=1`, restart the host, and approve the macOS
Screen & System Audio Recording permission for the responsible Sim Relay/helper/Terminal process.
The client then checks the explicit all-app audio acknowledgement before Listen is enabled.
Without the local environment opt-in, a paired client cannot start a host-wide capture. Revoke
the OS permission or disable the environment setting and restart the host to remove the capability.

Example for the background service:

```sh
SIM_RELAY_ENABLE_HOST_AUDIO=1 sim-relay-host restart
```

The service saves this opt-in across login/restarts. Set it to `0` and restart to disable it.
Development uses `npm run build` on the Mac to compile the helper, or a precompiled executable
can be selected with `SIM_RELAY_AUDIO_HELPER`. Runtime `--probe` detects missing/incompatible
helpers without requesting permission. Actual capture detects permission denial, a missing
desktop/display, and native stream failures with instructions to approve permission/retry.
No microphone permission is requested. A logged-out/headless host without a shareable display
cannot use this capture path. DRM/protected media and OS attribution/routing may produce silence.

Only one simulator session may own host-wide audio at a time, avoiding duplicate listeners and
unintended cross-session sound. Other sessions can continue silent video and recordings.
Per-process Core Audio taps are another supported native API (macOS 14.2+), but mapping all audio
processes belonging to a simulator UDID is not a supported stable CoreSimulator contract. Tapping
`Simulator.app` alone cannot promise isolation of app processes or CoreSimulator's audio services.
That path is deliberately not presented as per-simulator capture.

The helper requests 48 kHz stereo float capture and emits interleaved PCM16. Pipe writes are
below Darwin's 512-byte atomic-write limit and drop whole samples on backpressure. The host
coalesces into 20 ms packets, sends `SRA1` + PCM over the same WSS, and drops audio when the
socket backlog exceeds 64 KiB. The audio parser rejects invalid sizes and bounds pending bytes.
PCM costs about 1.536 Mbps plus framing/TLS overhead; audio is opt-in because it can materially
affect constrained links. There is no compressed-audio claim. The client allows one audio IPC
packet in flight, and Web Audio schedules at most roughly 140 ms including the next packet,
with at most eight sources; excess samples are dropped. Disconnect closes AudioContext, stops
sources, closes the helper's stdin, and awaits process exit/escalation. The helper also observes
stdin EOF if its parent crashes.

Audio and JPEG playback favor current content over backlog. They currently use arrival-based
playback, not a common capture timestamp/media clock, so **lip-sync is not guaranteed**. Native
capture/encoding delay and network jitter can produce skew; that must be measured with a
flash/click test. No capture-to-client latency or sync measurement is claimed. A future WebRTC
path can supply a common media clock. This limitation is separate from the bounded client queue.

Web Audio provides playback on Electron macOS/Windows/Linux; actual output-device behavior needs
native validation on each platform. Playback follows the OS default output. Resume playback
handles suspended contexts after device/system changes. Mute and the volume slider modify only
the client's GainNode; they never send simulated VOLUME_UP/DOWN or change the host system volume.
Stop audio releases capture; mute continues capture at zero client gain. Future browsers can use
the same PCM decoder after a user gesture, subject to their autoplay/output-device policies.

## Packaging and integration contract

`scripts/build-native.mjs` runs only on macOS, with Xcode's Swift 6 strict-concurrency compiler,
deployment target 13.0 and the current native architecture. Both macOS CI architectures compile
it during `npm run build`. `dist-host/sim-relay-audio` is copied with the existing `dist-host`
extraResources into `Contents/Resources/host`, outside asar; the packaging sign walker includes
embedded binaries. The helper embeds its own identifier/usage descriptions. Desktop macOS usage
descriptions are additive. Signed/notarized builds, TCC attribution, and macOS 13 runtime execution
still need actual Mac checks; Linux builds intentionally skip Swift compilation.
Nix builds also skip the helper (`SIM_RELAY_SKIP_NATIVE_AUDIO=1`) because their sandbox cannot
use the separately installed Xcode SDK. Supply a helper compiled outside that sandbox through
`SIM_RELAY_AUDIO_HELPER` to enable Mac audio for a Nix installation. Video/recording still work
without it. The Nix fileset includes the build script so Linux imports do not fail.

- Instantiate one `ClientMedia(socket, profile, sendToOwningWindow)` per display connection.
  Route messages to `media.message(data, binary)` first; forward ordinary JPEG via `media.video`.
  Route `video-consumed`, `audio-consumed`, and `video-feedback` IPC from that window only to its
  `consumed`, `consumedAudio`, and `feedback` methods. Await `media.close()` on disconnect/quit.
  Do not use a process-global instance when integrating multiple display windows.
- DesktopApi additions: `setQuality`, `reportVideoFeedback`, `startRecording`, `stopRecording`,
  `discardRecording`, `saveRecording`, `startAudio(hostAudioConsent)`, `stopAudio`, `onAudio`,
  and `onMediaNotice`. Existing stream/input methods stay sender-window scoped. The `onFrame`
  callback may now return Promise<void> so preload waits for decoding before acknowledging.
- Mount `<MediaControls api={api} connected={live} maxFps={requestedFps} onError={onError} />`
  once per main/pop-out display. Keep it mounted during connecting so early capability notices
  are not lost. It owns only local controls/playback, never another window's connection. A small
  workspace inspector and pop-out toolbar both mount it. A recording indicator remains visible
  in each display heading while the secondary media controls are collapsed.
- DeviceStage uses `subscribeVideo(api, () => canvas.current, onFps, onError)` with cleanup on
  disconnection. Keep its independent pointer/key cleanup and orientation metadata handling.
- Host Backend sessions optionally implement `setVideoSettings`. `startHost` accepts an injectable
  HostMedia for tests. Its MediaPeer is closed with the owning controller; new recording routes
  remain behind the host's authorization/origin checks. Root authorization changes must retain
  those checks on `/recordings/:id` and terminate revoked controller sockets.

## Native evidence (2026-10-23)

Verified on an arm64 Mac with macOS 15.7.1, Xcode 26.0.1, Node 24.16 and iOS 26.0.1, in a
private checkout with a dedicated iPhone 17 Pro simulator, isolated state, and loopback port 49319. Existing user devices, projects, installed Sim Relay and macOS security settings were
not modified. The first Mac production build, strict Swift helper build and all 17 then-current
unit/transport tests passed. Both arm64 and x86_64 helper binaries compiled; **Intel runtime
and packaged signing/notarization were not tested**.

Real WSS runs exposed and verified fixes for two issues: resetting the FPS gate to each arrival
unnecessarily dropped normally jittered frames; the recording supervisor's six-second shutdown
window was too short for a longer changed-screen recording. Pacing now preserves its clock,
and recording has its separate 30/35-second finalization bounds and retained diagnostics.
The Linux suite now has 19 passing tests, including regressions for those behaviors.

The final native pass used the fresh simulator's SpringBoard, controlled swipes, and status-bar
changes. Full 1206×2622 JPEG delivery was 149 frames in 5.001 seconds (29.79 FPS, 32.62 Mbps
including the initial token-bucket burst at a 30 Mbps long-run limit). Half resolution at
604×1312 delivered 75 frames in 5.001 seconds (15.00 FPS, 3.876 Mbps). Native input dimensions
remained 402×874 points. With a 1 Mbps video budget, capture stepped down to 482×1048 and
8 FPS requested; steady delivery was about 5–5.5 FPS and 0.94–1.03 Mbps. The 14-second ramp
averaged 0.651 Mbps. This is real local delivery under the controller's budget, **not an
externally shaped WAN test or a measured input-to-photon latency test**.

Start → controlled interaction → Stop produced a native silent H.264 MP4 at 1206×2622,
92 frames, 10.038333 seconds and 351,107 bytes. The production HTTPS download code streamed
it through pinned TLS and a temporary loopback SSH forward to a Linux x64 client, then FFmpeg
on both Mac and Linux decoded the whole file without errors. The Linux receipt includes its
SHA-256 digest. Successful discard and an additional active-recording abrupt disconnect both
left zero temporary recording directories. The temporary forward and private transfer
credentials were removed. See [the sanitized native result](media-native-validation.json).
The OS save dialog, QuickTime/VLC UI, browser downloads and Windows runtime were not exercised.

A first static-source run produced one decodable frame lasting .066667 seconds despite a longer
capture interval; simctl can depend on display updates and the last frame's timing. The changed
screen repeat above produced a full-length usable recording. A frozen/static source should not
be assumed to produce a movie matching elapsed wall time. SpringBoard stayed portrait, so this
run does not prove a landscape app's recording behavior. The generated test app compiled and
installed, but fresh-app launch remained stalled even after serializing simulators; no tone-app
playback or accessibility-runtime success is claimed.

The permission-only audio attempt returned: `The user declined TCCs for application, window,
display capture`. No PCM was persisted; the helper was released. The user chose to continue
without audio validation, so no further audio probes were performed. Hearing simulator audio,
output-device changes, permission grant/revoke behavior, and measured A/V skew remain unresolved.

Repeatable helpers are included: `node scripts/build-media-fixture.mjs /tmp/sim-relay-media-...`
builds an isolated quiet pulse app without installing it; `scripts/validate-mac-media.ts` requires
`SIM_RELAY_VALIDATION_UDID` naming a dedicated `Sim Relay Media Validation ...` simulator and
`SIM_RELAY_VALIDATION_DIR` under `/tmp/sim-relay-media-*`. `SIM_RELAY_VALIDATE_INTERACTION=1`
requests only owned-device swipes/status-bar changes. Audio stays skipped unless a separately
approved run explicitly sets `SIM_RELAY_VALIDATE_AUDIO=1` and enables host audio. The optional
external transfer checkpoint uses mode-0600 private files, never logs credentials, and removes
them during cleanup. `scripts/validate-media-download.ts` verifies the external pinned-TLS save
and full decode through the temporary port49329 forward. Fixture UI uses native labeled controls,
Dynamic Type and Reduce Motion; actual VoiceOver/large-text runtime checks remain unrun.

## Validation still required before closing issues

Combined-stack automation: `npm test` (78 tests), `npm run check`, `npm run build`, and real
headless Electron main/preload/renderer smoke. The latter verifies two pop-outs, retained recording
across transfers, sender-window media/quality routing, late capture-state replay, and native dialog
parenting with picker results stubbed. It does not exercise a real OS picker or real audio playback.
The standalone media suite and synthetic benchmark also remain reproducible.
Coverage includes quality bounds/recovery/decode feedback, split/hostile PCM framing, local audio
opt-in/single-owner/startup races, recording idempotency/startup cancellation/finalization/discard,
graceful process EOF/kill escalation, stale video-RPC suppression/native input coordinates, bounded
video/audio IPC, playback gain/mute/source cleanup, host errors, TLS fingerprint/auth/origin/ticket
rejection, streaming save/retry/abort, and disconnect cleanup. Native captures are injected fixtures;
the MP4 atom fixtures are not playable media and are not claimed as simulator recordings.

Remaining native/UI checks: validate landscape apps and playback in
QuickTime and VLC; repeat cancel/save retry, window close, shutdown, network drop, revocation,
host stop and SIGKILL, limits, and multiple simulators. Check no simctl/helper processes survive.
Validate OS permission denial/grant/revoke, packaged signing and both Mac architectures, a
representative simulator audio app, default-output changes, reconnect, mute/volume independence,
and a flash/click sync/latency test on each desktop client OS. Compare readability, actual bandwidth,
decode drops, and measured input-to-photon delay on fast LAN and a genuinely shaped 2 Mbps/80 ms
link. Real shaped-WAN text readability/responsiveness, remaining recording UI/platform checks, and representative simulator
audio remain unresolved acceptance evidence; do not close the issues based on the synthetic model.

## Primary references

- Apple: [ScreenCaptureKit sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos),
  [audio capture configuration](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturesaudio),
  [channel count](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/channelcount).
- Apple: [Core Audio process taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps),
  [simulator/device screenshot and video capture](https://developer.apple.com/documentation/xcode/capturing-screenshots-and-videos-from-devices).
- Meta: [idb protocol](https://github.com/facebook/idb/blob/main/proto/idb.proto).
- W3C: [WebCodecs and runtime codec-support detection](https://www.w3.org/TR/webcodecs/).
