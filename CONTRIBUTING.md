# Contributing

Keep changes scoped to an issue and describe user-visible behavior, validation and
remaining native acceptance in the pull request. Do not merge the review stack or
close native acceptance issues solely because build and fixture checks pass.

Test sources and runners remain private by the owner's explicit instruction.
Follow [the private validation workflow](docs/private-validation.md). Never use
`git add -f` to publish ignored tests, fixtures, benchmarks or raw evidence.
Public CI verifies published build/package inputs; release reviewers also need a
sanitized private regression report for the exact commit and applicable native
results. Installer and Nix source allowlists must keep private validation assets out.
