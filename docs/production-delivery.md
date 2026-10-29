# Coordinated stack delivery and private validation

The owner intends to merge all 15 PRs as one coordinated stack. The complete result
must reach `main` together, with the private-test policy preserved. This supersedes
the earlier proposal to merge #41 alone and leave the original feature PRs unmerged.
It does not authorize a merge, release, installation, or issue closure.

## Prepared top layer

PR #41 targets #40's branch, `fix/headless-audio-agent`. Its preparation adds an
integration commit with both the previously reviewed #41 candidate and #40 as parents.
The resolved tree preserves #41's production implementation, including the later HID
cancellation, rotation-dispatch and recording-presentation fixes. Only delivery and
acceptance documentation changes during this preparation. No published commit is
replaced, no force-push is needed, and the existing review evidence remains available.

The earlier #41 commit `700070af781d495fc9879ca6b4d467fcdbafaca8` was a standalone
one-commit candidate against `main`. That is historical evidence, not the current
stack shape. Preparing the top layer makes the old feature ancestry reachable from
#41 too; **ordinary merge commits or rebase merges into `main` would import it**.
The squash sequence below is therefore essential, not optional formatting.

## Reviewed merge procedure

GitHub has no atomic transaction for merging 15 PRs. Use one coordinated operation,
top down, updating only intermediate feature branches until #15 lands on `main`.
A partial failure can leave some intermediate PRs merged; stop and repair before #15.
Do not enable auto-merge across the stack or delete intermediate branches during this
operation. Freeze other branch changes or recheck them before each step.

1. Record all PR heads/bases, the prepared final tree and unchanged `main` SHA.
   Review the combined diff and the final fixes. Confirm squash merging is permitted
   by current repository rules and that the operator can update every base branch.
   Obtain the owner's merge decision, including treatment of outstanding acceptance
   cases. The [acceptance ledger](release-acceptance.md) does not waive them.
2. Revalidate the exact prepared tree with the private suite, type/build checks,
   relevant built-app smokes and package/source exclusions. Keep the suite, rehearsal
   program and raw reports private. Record their digests and sanitized results.
3. **Squash merge in this exact order:**
   **#41 → #40 → #39 → #38 → #37 → #35 → #33 → #34 → #36 → #32 → #16 → #19 → #17 → #18 → #15**.
   #41 first lands in #40's branch; the next PR carries that complete result down
   into its own base. #15 into `main` is the final step. Use an explicit reviewed
   squash title/body at every step: default commit-message generation can copy
   historical issue-closing keywords even when the current PR body has none.
4. Before each squash, compare the actual head/base with the recorded or freshly
   reviewed result. Wait for required checks and reviews on the changed head; the
   original green checks do not automatically cover a new squash commit. Inspect
   conflicts and require the intended complete final tree after each merge.
5. **Stop before #15** if any check, review, conflict or policy audit is unresolved.
   Reinspect its complete diff to `main`, including package allowlists and public CI.
   Simulate the final squash: it must add one commit with the old `main` as its sole
   parent, the reviewed final tree, no private validation paths, and no issue-closing
   keywords. Audit actual commit trees/ancestry, not only the working checkout.
6. After the owner-approved final squash, verify all 15 PRs' merged states and the
   final `main` tree/ancestry. Record the new SHA and checks, keep unresolved issues
   open, and preserve the private report. Do not tag, publish or install implicitly.

The [prepared candidate report](stack-preparation-2026-10-28.md) records the validation
and rehearsal scope. A local rehearsal of all 15 squash operations can prove tree preservation against a
specific set of refs. It cannot guarantee that later GitHub refs, rules or checks will
remain unchanged. Repeat the rehearsal after relevant updates. No rehearsal merges
GitHub PRs or advances `main`.

## Historical exposure

Some original feature commits accidentally published validation sources before #32
removed them from the final tree and public CI. The top-down squash chain keeps those
feature commits out of newly created `main` ancestry **only if executed and audited as
above**. Existing intermediate branches already contain that exposure; do not describe
their history as private. The final clean tree does not retract historical main/branch
objects, PR refs, forks or downloads. Removing or rewriting exposed refs is a separate
owner decision and cannot erase existing copies. Preserve existing refs during this
preparation; do not force-push them as a cleanup shortcut.

## Private-suite custody

The owner-only validation archive lives outside public Git, with a mode-0700 directory
and mode-0600 archive. Its manifest records each source digest, tested application
commit and combined suite digest. Restore the compatible archive through an approved
private channel before validating another checkout. The ignored working copy is not
the sole backup. No test/fixture/runner/raw-evidence sources belong in a public commit,
CI artifact, installer or Nix source input.

Public CI builds and checks production packaging. Private regression execution and
applicable native acceptance remain separate evidence. See the [validation policy](private-validation.md),
[recorded native follow-up](acceptance-followup-2026-10-28.md) and
[release acceptance ledger](release-acceptance.md).
