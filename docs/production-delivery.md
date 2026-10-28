# Production-only delivery and private validation

The feature PRs are review layers. Some early layers accidentally published private
validation sources before #32 removed them from the final tree. Merging those layers
into `main` would also import their earlier commits. Deleting files in a later commit
does not prevent that history from arriving on `main`.

## Delivery path

Prepare the reviewed final production tree on a candidate branch whose first new
commit has the existing `main` tip as its sole parent. Copy the tree, not the feature
branch ancestry. Subsequent candidate updates must descend only from that candidate
or an audited `main`; do not merge the old feature branches into it.

Before owner review, verify:

1. The candidate tree equals the final integrated production tree, including any
   acceptance fixes. Record both tree object IDs and the source integration commit.
2. No newly introduced candidate commit tracks regression sources, runners,
   fixture apps or raw evidence. Audit commit trees and path history, not just the
   final checkout. Confirm `main` ancestry is unchanged.
3. Private regressions and applicable native checks run against that exact tree.
   Record a private-suite manifest digest separately from the application commit.
4. Public build/package checks pass on the candidate. Actual package and Nix input
   inspection must exclude private assets independently of Git's ignore rules.

Review each feature through its existing PR and inspect the combined candidate diff
before merging. Merge only after the owner approves. Avoid automatic issue-closing
keywords: the acceptance ledger determines which issues can be closed after delivery.
Do not merge the original review layers into `main` afterward; their code is already
represented by the candidate tree. Their eventual closure is a separate owner action.

## Historical exposure

This path prevents importing the exposed test commits into `main`; it does not erase
the already published review branches, PR refs, cached objects, forks or downloads.
Keep the historical exposure recorded rather than claiming deletion made the tests
private retroactively. Rewriting/removing published refs requires a separate owner
decision and cannot retract existing copies. Preserve the original review branches
until that decision; do not force-push them as part of candidate preparation.

## Private-suite custody

The owner-only validation archive lives outside public Git, with a mode-0700 directory
and mode-0600 archive. Its manifest records each source digest, tested application
commit and a combined suite digest. The ignored working copy remains available for
local checks; it is not the sole backup. Restore the compatible archive through an
owner-approved private channel before validating another checkout.

Public CI builds and checks production packaging. Private regression execution remains
a separate release requirement; a public build result does not substitute for the
private report or native acceptance. See [the validation policy](private-validation.md)
and [release acceptance ledger](release-acceptance.md).
