# Unattended audio validation — October 26, 2026

The app-owned Core Audio path captured non-silent system playback over SSH while its
Mac user remained logged in in the background. Another user owned the display. Initial
approval was performed in System Settings; subsequent starts, a restart and an owner-crash
recovery required no Terminal window or additional approval.

This verifies unattended capture **after one-time approval in a logged-in user session**.
It does not verify operation after logout, before login, or without initial GUI consent.

## Native environment and identity

- macOS 15.7.1, arm64, Apple Swift 6.2; Xcode 26.0.1.
- SSH/capture user UID 502; display owner UID 501 during background checks.
- Helper identity `dev.simrelay.audio`, packaged as an `LSUIElement` app.
- Approved development executable SHA-256:
  `5588618973fd9b08908265b8d3770610fff0197aed1bfe7df2e8522e364e5a0c`.
- The three native source files used for runtime validation exactly matched the final
  source snapshot. The production native build script also built and verified the helper
  app. Intel cross-compilation passed; Intel execution was not tested.

The candidate was signed ad hoc. Stable Developer ID signing and permission persistence
across distributed updates remain release checks. The installed Sim Relay application was
not replaced. The approved validation bundle was preserved for inspection.

## Real capture and ownership results

A private fixture played one second of a quiet, generated 880 Hz tone using `afplay`.
Production capture emitted interleaved 48 kHz stereo PCM16. Only numerical measurements
were retained; captured PCM was processed in memory and discarded.

- Foreground-user SSH start: 172 host packets, 330,240 channel samples, peak 300,
  no capture faults; graceful retirement observed.
- Background-user SSH start: 176 packets, 337,920 channel samples, peak 299,
  no capture faults; graceful retirement observed.
- Background-user abrupt owner crash: the authenticated helper process disappeared
  within 0.089 seconds after the validation host was killed. A fresh SSH start then
  captured the tone again without prompting: 176 packets, peak 299, no faults.
- Production relay: native Core Audio → HostMedia → authenticated, certificate-pinned
  loopback TLS/WSS → ClientMedia delivered 116 PCM packets with peak 300. The measured
  880 Hz component confirmed delivery of the generated tone. Explicit all-app consent
  and an owner-granted viewer audio permission were required. Stop, restart, socket
  disconnect and host shutdown completed successfully.
- Final process inspection found zero owned validation processes.

The relay fixture used a synthetic video session and no simulator. It did not prove
simulator sound, remote WAN delivery, renderer speaker output, mute/volume behavior,
output-device changes, or flash/click A/V synchronization. Host-wide scope remains explicit;
no per-simulator isolation or lip-sync guarantee is claimed. No global output device,
volume, TCC database, security setting or existing host service was changed by validation.

## Private implementation validation

All 212 private Node regressions passed, including authenticated Unix-socket framing,
bounded delivery, startup cancellation, observed PID retirement, cleanup failures and
existing authorization/session/media behavior. Type checking and the production build
passed. A separate read-only review found no concrete defect.

The actual production Swift PCM processor also passed 12 synthetic cases: 44.1 kHz planar,
48 kHz interleaved and 96 kHz planar input, each split into callbacks of 1, 127, 1024 and
4096 frames. Callback boundaries produced identical resampled output. These synthetic
checks validate conversion behavior, not native permission or capture acceptance.

Tests, fixtures, runners and raw logs remain private and unpublished. See
[audio setup and limitations](media.md#mac-audio-13) for the operational contract.
