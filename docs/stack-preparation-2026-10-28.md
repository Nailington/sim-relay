# Coordinated stack preparation — October 28, 2026

The owner requested that all 15 PRs be prepared for a coordinated merge. No PR or
`main` was merged during this preparation. No installed application was replaced,
release tagged, issue closed, or published commit rewritten.

## Prepared result

PR #41 becomes the top layer against `fix/headless-audio-agent` (#40), rather than
a parallel PR against `main`. An additive integration commit preserves the original
#41 candidate `700070af781d495fc9879ca6b4d467fcdbafaca8` and #40
`5da5714bcec0290eabf9c5acfa3cbaeaacdfeb25` as parents. Its runtime/build source is
unchanged from the validated production implementation
`1a898d79f8021d2c732b0a9ceb5d0e1fd326f05b`. Delivery, acceptance and unreleased-note
changes reconcile the owner's merge plan and clarify partial versus complete results.
The prepared SHA/tree and subsequent CI state belong in the PR's current evidence.

The original `main` is `adbffabaef6f89225480c4eb1d8bc34697745dd6`.
The other 14 PR heads/bases are unchanged by this preparation. Their descriptions
now direct reviewers to the coordinated squash sequence rather than the superseded
standalone #41 delivery proposal.

## Rehearsal and validation

A private local rehearsal resolves #41 to its reviewed production tree and simulates
all 15 top-down squash operations. At every step the resulting tree must equal the
prepared target. The simulated final #15 squash has the original `main` as its sole
parent, exactly one new commit, and no project test/fixture/runner/private-evidence
paths. The rehearsal writes unreferenced local Git objects only. Repeat it if refs
or the target tree change; it is not an atomic GitHub merge or merge authorization.

The prepared working tree passed:

- TypeScript checking and the complete production build.
- **248 private regressions, zero failures and skips.** The restored suite matches
  manifest SHA-256 `c9d247b2a9ed408fa9f9f92cd83ee3f60f82c7af554d4fb05893ed7a27ae702d`.
- Built React renderer, Chromium workspace, shared-account identity and Electron
  session/recording ownership smokes. Hosts, picker results and browser recording
  bytes in these checks are fixtures; they are not native platform acceptance.
- Both x86_64 Linux Nix packages and their evaluated-source exclusion checks.
- A fresh unpacked Linux Electron payload and the published archive/resource check
  excluding private validation assets and requiring the browser command/frontend.

Tests, rehearsal source, reports and raw logs remain ignored/private. No fresh Mac,
Windows, real browser-touch or native audible-output experiment was performed during
this documentation/stack preparation. The earlier [native follow-up](acceptance-followup-2026-10-28.md)
retains its exact source, environment, results and limitations.

## Owner review and remaining gates

Use the [coordinated procedure](production-delivery.md): squash #41 down through the
stack and #15 into `main` last. Recheck rules, refs, required checks and reviews on
each changed head. Use explicit squash messages without automatic closing keywords.
Do not ordinary-merge/rebase the exposed feature ancestry into `main` or merge #15
before the final integrated tree has reached it.

The owner still decides whether remaining native cases block code integration or
remain open release follow-ups. Nothing in this report accepts the compatibility
limits on the owner's behalf. Windows hardware is unavailable; installed-platform
windows/dialogs/secure storage, real interruption/sleep-wake, actual Homebrew
replacement, real touch/downloads, external rotation and broader gestures, audible
client playback/output changes/A/V skew and signed-helper permission persistence
remain incomplete. The [acceptance ledger](release-acceptance.md) and
[unreleased notes](release-notes-unreleased.md) preserve those distinctions.

Historical test exposure in existing branches/PR refs/copies remains a separate
owner decision. Top-down squash prevents importing feature commits into newly created
`main` history only when executed and audited correctly; it does not retract copies.
Keep all issues open until their individual remaining criteria are met.
