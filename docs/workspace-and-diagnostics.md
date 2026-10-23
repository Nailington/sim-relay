# Workspace and diagnostics

The workspace keeps Mac selection, simulator selection, and the display in one desktop view.
Choose a Mac in the left rail, choose or create a simulator, then use **Start & connect**.
The header identifies the target Mac; the display header identifies the simulator. Opening a
URL, pasting text, setting location, and running commands repeat their target in the dialog.
Disconnecting a display leaves the simulator running. **Shut down simulator** powers it off.

## Design decisions

The design uses cool paper (`#f4f6fa`), white (`#ffffff`), slate ink (`#202b3b`), relay blue
(`#275cc8`), steel (`#65748a`), and amber (`#986416`). Platform system type provides native
text metrics without a font download; monospace is reserved for commands and reports.
Alignment is left aligned except for the centered display. Selection uses color and a
check or leading rule; status always includes text.

The initial plan placed simulator cards above the display. Review against the developer
workflow showed that this repeated the old screen's main problem: navigation competed with
the simulator for vertical space. The implemented layout puts both kinds of selection in
a rail, leaves the display full height, and lets controls scroll independently. The display
is the characteristic element, with no marketing hero, ornamental grid, or dashboard cards.

## Cleanup inventory for #14

This records the implemented removals, consolidations, relocations, and repairs, including
the reason for each. It applies to normal and expanded workspace modes and all dialogs.

- **“Personal workspace” switch, “P” avatars, and alpha badge: removed.** There are no accounts,
  workspace switching, or profile actions behind them.
- **“Your Mac. Anywhere.”, “Big ideas. Any screen.”, “Built for the way you build.” and the
  “Put your Mac to work” promotion: removed.** They occupied working space without advancing
  connection, simulator selection, or input.
- **Workspace breadcrumb and selected “Simulators” navigation row: removed.** There is one
  workspace, so neither gave the user another destination.
- **Host strip, connection badge, inspector encryption footer, and footer network indicator:
  consolidated.** The header identifies the selected Mac and address; the simulator header
  reports actual display state. A saved pairing is labeled “Paired,” never inferred to mean
  reachable. Diagnostics confirms TLS and authentication independently.
- **Hardcoded `v0.1.0` and “Local first. Cloud free.” footer: removed.** Diagnostics reads the
  installed app version and protocol. There is no fabricated version or green health dot.
- **Horizontal simulator cards: relocated into the rail.** The list scrolls without pushing
  the display below the viewport. Device name, runtime, state, search, and running filter remain.
- **“New simulator” button and “Create a simulator” card: consolidated** into one labeled
  creation action beside Simulators. Empty states expose the same action where it is needed.
- **Three command-panel entries: consolidated** into the top **Command** action and its
  Ctrl+K / Cmd+K shortcut. It remains available when controls are hidden or the view expands.
- **Repeated Start & connect buttons: consolidated** into the display header. The disconnected
  state explains that action and that disconnecting preserves the running simulator.
- **Forget Mac: relocated** from an unexplained unplug glyph into Mac options with a specific
  target and explanation that it removes this computer's saved pairing.
- **Persistent gesture and connection instruction blocks: reduced.** Brief input hints remain
  beside the display, with setup, gestures, shortcuts, and connection instructions in Help.
- **Decorative device bezel, shadow, and background grid: removed.** The framebuffer keeps
  its aspect ratio; normal and expanded modes use the available stage. DeviceStage's input
  and decoding contracts remain intact for the rotation/windowing integration.
- **Controls that cannot operate without a stream: retained with a prerequisite.** The panel
  explains “Connect the display to use simulator controls.” Hardware, text, URL, location,
  appearance, and shutdown are not silently discarded.
- **Screenshot and app-install demo actions: repaired.** They are disabled with explicit
  “Connect a real Mac” tooltips instead of opening a pretend success path. Other demo actions
  explicitly report simulation and the persistent banner identifies the entire preview.
- **Browser pairing submit: disabled with an explanation.** The browser demo has no native
  transport. The address form tells users to use the desktop app. The separately implemented
  browser gateway can supply its adapter without changing App's API use.
- **Unavailable runtimes and incompatible device types: repaired.** Creation excludes unavailable
  runtimes, explains missing components, and cannot submit an empty device type.
- **Default light appearance selection: removed.** Neither appearance is represented as known
  until the user sets it, and selection resets when changing simulator or Mac.
- **Host setup on non-Mac clients: contextual help.** It gives concrete Mac setup instructions
  and has no unusable Start sharing button. On a Mac, Start/Stop sharing still work. The pairing
  code can be refreshed after it rotates on hosts advertising separate client authorization; secrets remain confined to the host setup dialog.
- **Dialog titles and action copy: standardized.** Create simulator, Open URL, Paste text,
  Set location, and Run simctl command describe the actual outcome and target.

Useful features remain: host discovery/direct pairing, certificate comparison, secure-storage
feedback, forgetting a Mac, host sharing, simulator search/filter/create/refresh/start/shutdown,
disconnect, normal/expanded display, keyboard/touch gestures, Home/Lock/Rotate/Shake/volume,
PNG screenshot, zipped app installation, URLs, Unicode paste, location, simctl commands with
confirmation for destructive commands, iOS appearance, and requested frame rate.

## Diagnostics and export

Open **Diagnostics** in the header, even when no Mac can be reached. **Refresh health** checks:

- Network probe and supported protocol.
- Certificate equality with the saved pin, before sending a credential.
- A pinned, authenticated inventory request, with a ten-second request timeout.
- Xcode and companion readiness, plus the count of available simulator runtimes.
- Current display observations, with simulator boot inferred only after decoded frames arrive.
  Cached device-list state does not prove a currently unreachable simulator is running.
- Relevant recent client events for network, TLS, authorization, compatibility, setup, boot,
  streaming, input, and other simulator actions.

Each check is **Ready**, **Needs attention**, or **Unavailable**. Unavailable means the check
was not confirmed, rather than a confirmed missing dependency. Failed checks give a specific
recovery step. Input sending alone is not treated as proof that the simulator accepted it;
input remains unverified unless a failure is observed. Xcode/companion readiness is the host's
startup observation: restart sharing after installing or changing those dependencies.

Recent events are a bounded, memory-only log of up to 100 stage/outcome/timestamp records.
They are scoped to the selected Mac, or unscoped connection attempts when no Mac is selected.
They reset on app restart. They do not collect terminal logs, raw errors, request arguments,
URLs, pasted text, input payloads, installed app contents, or screenshots.

**Review report** shows the complete JSON that will be saved. Users may exclude host version
and runtime count or recent events. **Save report…** opens a local save dialog; cancellation
writes nothing, and nothing is uploaded. The main process independently validates the report
again using the same strict schema used for the preview. Unknown fields are rejected.

Exported data is limited to:

- Numeric app release versions, platform enum, and protocol versions.
- Timestamps, stage/state enums, available-runtime count, and limited session observations
  (stream state, decoded frame rate, and whether frames confirmed boot).

Host/device names, addresses, identifiers, credentials, tokens/codes, cookies, certificate
material, private keys, local paths, and arbitrary log strings have no place in the report
schema. Even prerelease version suffixes are excluded to avoid exporting free-form text.
Pattern-based redaction is additionally used for technical details shown in the interface;
export safety does not depend on a pattern recognizing every possible secret.

## Integration points for sibling work

- `App.tsx` retains the existing `connect`, `stopStream`, `input`, and notice/frame interfaces.
  The `viewer-heading-actions` block has an explicit extension point for pop-out, retry,
  cancel, and return actions. Add a return-display handler beside the existing notice effect.
- `DeviceStage.tsx` is unchanged. Its updated rotation/sizing implementation can be integrated
  separately. CSS provides `.viewer-panel`, `.viewer-heading`, `.viewer-content`, `.display-area`,
  and `.inspector`; `.controls-hidden` hides controls and `.expanded` hides the selection rail.
- Reuse `IconButton`, `Modal`, `ActionModal`, and `DiagnosticsModal` in a standalone display
  window. `CreateModal.hostName` is optional for existing call sites. Simulator controls remain
  in the workspace inspector; the standalone window can put them in its toolbar/actions menu.
- `DesktopApi.diagnostics?(hostId?)` and `exportDiagnostics?(report)` are optional additions.
  Preload forwards only these restricted calls. A browser adapter without them gets an explicit
  unavailable state; it must not claim mock host readiness.
- `electron/diagnostics.ts` takes injected profile/probe/inventory dependencies and records no
  credential material. `main.ts` registers its handlers and instruments restricted IPC actions
  plus stream errors. When merging sender-scoped sessions, retain that caller validation and
  pass the correct host ID to `record`/`failure`; never record payloads or raw errors.
- `remoteRequest` adds an optional fifth `timeoutMs` argument, defaulting to the existing
  130-second operation timeout. Only diagnostics requests use ten seconds.
- Authorization protocol changes can retain `Profile.token` as the client credential. The UI
  calls it a pairing code only in the exchange/setup flow and explains rotation when
  `HostInfo.clientAuthorization` is true. Older hosts get explicit shared-code wording.
  That optional capability is retained by `parseHostInfo`. Legacy hosts
  without an advertised protocol are identified as protocol 1.
- `package.json` adds `npm test` using Node's runner and tsx, matching the root work. Tests are
  explicitly tracked despite the repository's existing test ignore rules. No dependency or
  lockfile changes are required.

## Validation performed here

- `npm run check` and `npm run build` pass on Linux.
- `npm test`: 13 diagnostics tests, including a real ephemeral HTTPS server, pinned certificate
  verification, invalid credentials, no credential on the bootstrap probe, and no authenticated
  request after a pin mismatch. Other cases cover offline checks, missing dependencies/runtimes,
  protocol failures, event bounds/scoping, strict export validation, omission choices, and detail
  redaction. These tests use fake host data; they do not start Xcode or an iOS simulator.
- T3 collaborative preview: visually checked normal 1280×800, minimum desktop 980×680, large
  1920×1080, and narrow 375×812 layouts, plus expanded view at large/narrow sizes. No document
  horizontal overflow; display frame stays inside its stage; the inspector scrolls independently.
- Preview interaction checks cover selection, filters/search, disconnected state, create and
  pairing dialogs, controls hiding, expanded/return view, diagnostics/review. Synthetic keyboard
  events exercise / search focus, Ctrl+K command opening, modal Tab/Shift+Tab wrap, background
  inertness, and Escape. This is handler verification, not native keyboard/VoiceOver testing.
- A browser-injected, explicitly named mock Mac exercises offline health and review/save UI
  without claiming a real connection or native file-dialog save.

Native macOS/Windows UI behavior, real simulator video/input/rotation, the OS save dialog, and
sibling pop-out/session/media behavior require integration validation on their platforms.
No PR is merged and no issue is closed by this work.
