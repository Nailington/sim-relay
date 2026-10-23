# Display windows, reconnection and input

Choose a simulator and use **Pop out display** in the display header. The display opens in an independent native Electron window on macOS, Windows and Linux. Connect other simulators in the workspace and pop them out to keep several displays active, including displays on different paired Macs. Host and simulator names identify every window. Only the focused screen receives keyboard input.

Home, Rotate and Save screenshot are directly available in the top toolbar. **Hardware** contains Home, Lock, Rotate, Shake and both volume controls. **Actions** contains screenshot, install, URL, text, location, simctl, Light and Dark. **Display** contains frame rate, measured performance, connection/retry/cancel, disconnect, maximize, full screen, return and shutdown. Menus remain keyboard accessible and wrap at narrow window sizes. Escape closes a toolbar menu. Action dialogs, progress and errors stay in that display; native save/open dialogs use that window as their parent.

Returning a display transfers its transport and frame rate back to the workspace. If the workspace already has an active display, that display moves into another window first. A disconnected display stays disconnected when returned. Closing a display disconnects that stream and releases held input; it never shuts down the simulator. The workspace can be minimized or closed while other display windows remain open. Use **Return to workspace** to reopen it.

Opening the same simulator twice focuses its existing active window, rather than taking control. A disconnected or terminally failed window does not reserve the simulator. A different client's controlling connection produces an explicit conflict requiring that client to disconnect first. A retry also checks local ownership so a previously disconnected window cannot take over a display opened elsewhere.

Each active display has its own companion process, encoder, JPEG decoding, transport, frame rate, retry timer and held-input state. There is no fixed client session limit; practical capacity depends on the Mac's CPU/GPU/RAM and network bandwidth. Start with two displays at 15 or 30 fps, watch decoded frame rates, and disconnect unused displays. No maximum simultaneous count or 60-fps capacity has been measured on real hardware for this change.

## Recovery

The selected host, simulator and requested frame rate survive a temporary interruption. Automatic recovery retries after 1, 2, 4, 8, 16 and 30 seconds, then stops and offers manual Retry. Those delays exclude connection/startup time. Heartbeats detect a dead network transport; HTTPS preflights have a 15-second idle timeout, WebSocket handshakes 10 seconds, and stream startup 60 seconds. Retry status reports the attempt and delay. **Cancel** or **Disconnect** cancels retry timers and pending HTTPS requests. No input is queued or replayed across a reconnect.

Recovery checks the original host's pinned TLS certificate, compatible protocol, authorization and current simulator inventory. It connects only if that same simulator remains booted. A stopped/deleted simulator, controlling-client conflict, changed certificate, revoked/invalid credentials (HTTP 401/403, authorization_required notice or close code 4003), or incompatible protocol stops automatic retries. Re-pair for changed certificates or authorization; use **Start & connect** explicitly to boot a stopped simulator. Automatic retries never call boot.

## Screen geometry and orientation

The screen has no decorative frame, internal padding, rounding or added black bands. It fits and centers in the available space at the stream's aspect ratio, including expanded mode and resized windows. Any unused space remains outside the screen. JPEG dimensions can change mid-stream; metadata is sent before the associated frame, including rotation-only changes. Physical host orientation and the legacy HID landscape naming convention use opposite landscape names; orientation source selects the correct transform. Input uses the displayed screen rectangle and maps through the inverse visual rotation into the host's surface coordinates.

Legacy idb companions expose a portrait framebuffer even when the app's content rotates. Sim Relay carries a clockwise `StreamMeta.rotation` (0/90/180/270), draws the surface upright, and maps input back. Client Rotate tracks requested orientation for these companions. Companions supporting upstream `get_orientation` are polled every 500ms to observe external rotations. New companions advertising `TargetDescription.displays` already compose their video in interface orientation, so Sim Relay leaves their frames unrotated and follows encoded dimensions. Physical orientation and app interface orientation are distinct: an app can deliberately remain portrait.

**Compatibility limit:** an older companion returning UNIMPLEMENTED for `get_orientation` cannot report Simulator.app rotations. Use Sim Relay's Rotate control, or update the companion to one implementing orientation reporting. The UI reports this limit in Gesture help when the source is unavailable. External rotation, landscape direction conventions, upside-down orientation, portrait-only apps, and HID coordinates on actual companion/Xcode combinations still require the manual checks below. This PR does not claim those real-Mac checks passed.

## Gesture capability assessment

The [upstream idb protocol](https://github.com/facebook/idb/blob/main/proto/idb.proto) provides one `HIDTouch.point`, key/button presses, swipe, a center/scale/duration/radius pinch primitive, orientation and shake. It has no contact identifiers, contact arrays or two-finger rotation event. Sending independent touch events on parallel RPCs would still address the same single contact and can corrupt gesture ordering; Sim Relay does not do that.

- Mouse/pen/touch click and drag: one contact, including long press and swipes. Movement sends at most approximately 60 events per second; lift includes the final point.
- Alt + drag: a centered pinch applied on lift. Control/Command + wheel: short discrete pinch steps. Ordinary wheel: short single-contact swipes. These are finite idb gestures, not a continuously held two-finger input stream.
- Touchscreen: two pointer contacts compute a center and distance ratio. The first single contact is released when the second arrives; lifting applies one pinch. A third contact is ignored. This supports distance changes only, not independent paths, moving a two-finger center, continuous pinch or twist. Cancellation discards the pending pinch.
- Keyboard: supported USB HID key codes while the screen is focused. The host pasteboard action remains the route for Unicode text; it does not synthesize arbitrary keyboard layouts.
- Window/canvas focus loss, visibility loss, pointer cancellation/lost capture, orientation/dimension changes, disconnect and shutdown release active contact/key state. Renderer release requests expand into legacy touch/key UP primitives at the session boundary. The host also drains releases before closing its owned companion process. An in-flight finite idb pinch/swipe completes at its RPC boundary; it cannot be continuously steered/canceled through this protocol.

A native adapter could synthesize arbitrary contacts using [idb's underlying HID transports](https://github.com/facebook/idb/blob/main/FBSimulatorControl/HID/FBSimulatorHID.swift) and private CoreSimulator interfaces, but it would require a new negotiated contact protocol, per-runtime compatibility testing and release tracking. Apple's supported alternative is an XCUITest runner, which can issue finite multi-touch/pinch/rotation gestures but requires installing a test bundle and is not a generic low-latency arbitrary-contact relay. Neither is enabled or presented as implemented parity. See [idb UI documentation](https://fbidb.io/docs/idb/ui/) and [FBSimulatorControl's capabilities](https://github.com/facebook/idb/blob/main/FBSimulatorControl/README.md).

## Renderer/Electron integration contract

Existing `DesktopApi.connect(hostId, udid, fps)`, `disconnect()`, `input(event)`, `onFrame`, `onNotice` calls are scoped implicitly to the validated sender BrowserWindow and its main frame. Credentials never enter a display context. A per-window session owns the transport; moving a session changes the frame/notice destination without duplicating the connection. A repeated connect to an identical active target reannounces its status/metadata without opening another socket or resetting a retry budget. Main-process blur also releases tracked input.

Additive APIs:

- `popOut(hostId, udid, fps)`: validate selection and open/focus an independent display.
- `displayContext()`: the public host/device identity, requested fps and whether the transferred session is active; normally undefined in the workspace, except a one-shot restore context when reopening a closed workspace.
- `returnDisplay()` and `onReturnDisplay(context)`: transfer ownership and restore workspace selection. `context.sessionActive` prevents canceled sessions from restarting.
- `retry()`: retry this window's retained target with the same settings after checking ownership.
- `windowAction('maximize' | 'fullscreen')`: native window state controls.
- Input `release`: IPC cleanup request, expanded to protocol-1 compatible releases by RelaySession; also accepted by the updated host.
- `StreamNotice.type = 'status'`, `state = connecting/live/retrying/off/failed`, optional `attempt`, `retryInMs`, `message`; host errors may mark `terminal` or `code`.
- `StreamMeta.rotation`, `orientation`, `orientationSource = host/requested/unavailable`; width/height and point dimensions describe the encoded/input surface. `displayDimensions`, `fitDisplay` and `surfacePoint` centralize display geometry.

`DisplayWindow.tsx`/`display.css` contain only the pop-out controls and screen layout, avoiding a dependency on the workspace redesign. Media/recording APIs can be added to its Actions menu and should retain sender-window routing and native dialog parenting.

## Validation

Automated checks (Linux, fake simulators):

```sh
npm run check
npm run build
npm run test:sessions:native # Linux headless Electron; uses a fake host and isolated userData
node --import tsx --test tests/session-architecture.test.ts tests/display-coordinates.test.ts tests/session-host.test.ts
```

The tests cover bounded retries, explicit cancel, stale connection suppression, release/no replay, terminal auth/certificate/protocol failures, active ownership and transfer, independent hosts/input/frames, exact rotated coordinates/aspect fitting, real pinned HTTPS/WebSocket connections to two fake simulators, conflict reporting, rotation-only metadata and refusal to start a shut-down simulator. A headless Electron 45 smoke test runs the real built main/preload/renderer against a fake host, opens two native BrowserWindows, transfers sessions without duplicate sockets, verifies independent input, duplicate focus, disconnected reservations and returning into an occupied workspace and reopening a previously closed workspace. Screenshot/install dialog methods are stubbed to assert the correct BrowserWindow parent; no operating-system picker is actually shown. This is Linux-only verification, not a real simulator or macOS/Windows window test. Browser inspection additionally checked normal/expanded screen bounds and toolbar menus at 360px.

Manual release gate (not run here; iOS devices unavailable on this Linux environment):

1. On a Mac with a landscape-capable app, rotate through all four orientations in Sim Relay and Simulator.app, then return portrait. Test current companion and a legacy companion. Check upright content, screen corners, taps, scrolls and pinch centers; verify portrait-only app behavior.
2. On macOS, Windows and Linux clients, detach, resize to 360px, maximize, full screen and return. Run every toolbar action and its dialogs/file pickers. Verify keyboard traversal, menu Escape, focus restoration, install progress/errors, and screenshot destination parent.
3. Open at least two real simulators on one Mac and two Macs. Verify input/hardware/quality isolation, duplicate focus and external-client conflict. Minimize/close the workspace, then return a display; ensure other displays continue and no simulator shuts down.
4. Hold a key/touch, interrupt networking, sleep/wake the Mac, and restart its host. Verify release and recovery, bounded retries, manual retry/cancel and no queued input. Shut down the simulator while disconnected and verify automatic recovery does not boot it. Revoke authorization or replace a certificate and confirm terminal re-pair guidance.
5. Exercise Safari/Maps pinch, Home Screen swipe, long press, dragging, text fields and touchscreens; interrupt each gesture with focus loss, pointer cancellation, orientation change and disconnect. Check no stuck input. Verify guidance accurately describes discrete pinch and missing twist/independent-contact support.
