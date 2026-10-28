# Private validation checkpoint — 2026-10-25

Application commit: `0e2d0492f187ac97a0d8cc4f74d1df6f0d9093b7`; displayed version 0.1.5.
This is a foundation checkpoint before the remaining route/recording changes and
HTTP-retirement review fix. It is not integrated release-candidate acceptance.

Environment: NixOS 26.11 (build 26.11.20261017.353adf2), Linux x64,
Node 24.21.0, Electron 45.0.0 (its bundled Chromium; standalone browser not used).
No Mac, simulator, native audio or Windows runtime was used in these checks.
Private bundle manifest SHA-256: `c1ba46dbc1fec866bf1bda0f199d29529c574698174aea8fadb5820b945224fc`.
Manifest method: sorted relative file names in `tests/`, each followed by NUL and
the binary SHA-256 of its bytes, concatenated into SHA-256. This report publishes
no validation sources or raw captures. Public build CI is separate.

Passed:

- `npm run check` and `npm run build`.
- `node --import tsx --test tests/*.test.*`: 148 passed, zero failed/skipped.
- `node --import tsx tests/browser-renderer-smoke.ts`: built React hydration,
  returned-context error ordering, legacy FPS, quality cache and Updates UI checks.
- `node --import tsx tests/browser-workspace-smoke.ts`: actual separate Chromium
  cookie contexts, authenticated input/quality isolation, streaming download paths,
  reviewed diagnostics export, popup/return, persistence, revocation and cancellation.
- The same browser command with `identity`: sibling-tab reset, account handoff,
  permanently invalid stale APIs and identity-bound HTTP/WS actions.
- `node --import tsx tests/native-session-smoke.ts`: actual built Electron
  main/preload/window ownership transfer, retained capture, workspace recreation,
  independent fake-host inputs and dialog-parent assertions.

These are private injected-backend regressions. The fixtures act as the local Mac
owner to grant paired clients explicit controller/capture access; production pairing
still defaults to viewer with no devices. Native dialog results and file sinks are
injected, MP4 data is synthetic in browser flows, and audio is fake in the Electron
ownership check. No native save-picker, playable native recording, real OS keychain,
physical network interruption or per-platform installer acceptance is implied.
Expected-negative Electron IPC rejection logs occurred; success sentinels and final
ownership/input assertions passed. A stale private assertion matching old auth wording
was corrected to require the explicit `legacy_pairing` code and the driver rerun.

The independent review separately reproduced a clean-retirement timing failure at
this commit. Passing regressions do not clear that finding; the fix and a new private
regression are required before the candidate is considered review-ready. Native gates,
historical evidence and unresolved failures are tracked in the
[acceptance ledger](release-acceptance.md). Rerun affected checks on the final stack.
