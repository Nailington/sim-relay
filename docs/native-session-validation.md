# Session validation evidence — 2026-10-23

PR18 is stacked on authorization PR15. The integrated branch at `cce3685` passed `npm run check`, all **31** tests from `npm test`, and `npm run test:sessions:native` (production TypeScript/Vite/Electron/host build plus Linux headless Electron smoke). The latter exercises actual main/preload/renderer window routing with a fake Mac backend and single-use `/pair` exchange. Native picker methods are stubbed to assert their parent; real OS picker presentation is not verified.

A separate authorized Mac check then ran the bundled production `SimulatorSession` backend against two real, newly created simulators. This check did not run the Electron client on macOS or test HTTPS reconnection: it directly exercised the owned idb gRPC sessions and captured raw JPEGs/metadata.

Environment:

- macOS 15.7.1; Xcode 26.0.1 (17A400); Node 24.16.0.
- Installed `idb_companion` reports build date Oct 22 2026. The idb Python/CLI is absent; no software was installed or upgraded.
- Private working directory: `/tmp/sim-relay-session-20261023-cce3685` on the Mac.
- Dedicated A: `A67C69C6-C2B2-4FA3-8C1B-075B1F471F3C`, “Sim Relay Session Validation A”, iPhone 17 Pro / iOS 26.0.1.
- Dedicated B: `8737477B-603E-4847-B4BE-36E68546D819`, “Sim Relay Session Validation B”, iPhone 17 / iOS 26.0.1.

Observed results:

1. Both real companion sessions streamed concurrently at requested 15 fps. At the first snapshot each had delivered 44 frames; by the final snapshot each had delivered **183 frames**, with no video/HID error callbacks.
2. Both report an encoded surface of 1206 × 2622 and 402 × 874 simulator points (density 3).
3. `describe` returned an empty `displays` list, and no usable host orientation was reported (`orientationSource` stayed `unavailable`). The exact orientation RPC failure code was not logged. This session therefore followed the legacy portrait-surface path; the newer externally reported orientation path remains unverified on hardware.
4. Sending legacy `LANDSCAPE_LEFT` to A changed A's metadata to `rotation:90`, `orientationSource:requested`; B remained `rotation:0`, `orientationSource:unavailable`. Restoring A to portrait returned its rotation to zero. Both streams kept advancing. This verifies independent routing and requested-orientation metadata, **not upright Safari content or actual rotated hit targets**.
5. Owned sessions closed through their normal cleanup paths. No global companion kill or user-device action was used.

Limitations encountered:

- Fresh A's SpringBoard frame showed missing/black app icons. Safari `simctl openurl` timed out with NSPOSIXErrorDomain code 60, and a subsequent launch also stalled.
- A bounded accessibility RPC failed with `13 INTERNAL: The simulator's accessibility service named no frontmost application`.
- The parent and media agent reported severe Mac memory pressure while multiple fresh simulators were running. Native work was stopped as requested; both owned session simulators were shut down successfully to release memory. No TCC/security settings, existing devices, user project or installed tools were changed.
- Consequently representative Safari/Maps gestures, visual orientation correctness, external Simulator.app rotation, real-app rotated coordinates, stuck-input UI behavior, Mac sleep/wake and host/network restart recovery still require a serialized follow-up. Existing deterministic and fake-host coverage must not be described as those real-device checks.

Evidence is preserved outside the repository without credentials:

- Local `/tmp/sim-relay-session-artifacts/phase1-retry.log`: complete metadata/frame counts and the bounded accessibility error.
- Local `/tmp/sim-relay-session-artifacts/artifacts/landscape-metadata.json`: A's requested landscape transform.
- Local `/tmp/sim-relay-session-artifacts/initial-A.jpg` and `artifacts/frame-0.jpg`, `artifacts/frame-1.jpg`: raw owned-device frames. Final frames were captured after restoring portrait; no landscape screenshot success is claimed.
- Local `/tmp/sim-relay-session-artifacts/mac-phase1.ts` and `.cjs`: exact isolated runner used, including owned simulator IDs and cleanup.
- The corresponding logs, runner and artifacts remain in the private Mac directory above. No host authorization state was copied.
