# Private validation and publication policy

The owner reconfirmed on 2026-10-25, for issue #31: **Keep test sources private;
use a private validation workflow.** This continues the earlier project instruction.
The previously tracked tests and public CI test steps were a mistake, not a policy
change. Current-tree removal cannot retract copies from previously published Git
history, forks or downloaded artifacts; historical removal needs a separate decision.
The [coordinated stack delivery procedure](production-delivery.md) uses top-down
squash merges to keep those exposed feature commits out of newly created `main`
ancestry without rewriting the existing review branches. Ordinary merge/rebase of
the original feature commits does not provide that protection.

## What stays private

Regression sources, test runners, fake host drivers, native fixture apps, benchmark
runners, credentials and raw capture evidence must not be committed, force-added,
uploaded as public CI artifacts or copied into production packages. `tests/`,
`.private-validation/` and the existing local validation script paths are ignored.
New validation helpers belong under one of those ignored paths. An ignored path is
publication protection, not encryption or an operating-system access boundary.

The existing regression bundle was preserved locally before untracking. Keep a
restricted-access backup of that bundle outside public Git, indexed by the tested
application commit. A new contributor obtains it from the owner through an approved
private channel; a public checkout alone does not contain or run the private suite.
Do not store private-suite tokens in a public workflow. A separate access-controlled
CI checkout may restore the suite and invoke the same local commands.

## Reproduce meaningful validation

1. Check out the exact application commit and install its locked dependencies with
   `npm ci`. Restore the compatible private bundle into ignored `tests/` and local
   script paths. Run `git check-ignore` on restored paths and confirm `git ls-files
tests` returns no files before publishing a branch.
2. Run `npm run check`, the private Node regressions with
   `node --import tsx --test tests/*.test.*`, and `npm run build`.
3. Run the private renderer, browser and native Electron drivers against the built
   app. Existing driver names are `tests/browser-renderer-smoke.ts`,
   `tests/browser-workspace-smoke.ts` (normal and `identity` modes), and
   `tests/native-session-smoke.ts`; invoke each with `node --import tsx`.
4. For native checks use dedicated devices and bounded cleanup. Do not start audio
   capture or change TCC without the owner's explicit authorization. Simulated
   backends and injected picker results do not establish native acceptance.
5. Record the application commit, private-suite revision or digest, environment,
   exact commands, exit results, counts and limitations in a sanitized validation
   report. Publish that report only after checking it contains no source, secrets,
   private paths, user content or raw captures. A report is evidence, not a copy of
   the suite. Re-run after relevant fixes; do not infer success for untested commits.

If the private bundle is unavailable, report validation as blocked. Do not remove
coverage, fabricate a passing result or replace it with a build-only claim.

## Public CI and production contents

Public CI type-checks, builds all supported desktop installers, evaluates/builds
the Nix package and verifies package payloads and metadata using published packaging
tools. It does not claim to execute private regressions. Release approval also
requires the matching private validation report and applicable native acceptance.

Electron's explicit `build.files` and platform `extraResources` in `package.json`
govern installed payloads. Nix's `lib.fileset` in `nix/package.nix` independently
governs source inputs. Preserve these allowlists when adding runtime assets; a file
being present in Git never authorizes shipping it. Inspect packaged archives and
the evaluated Nix source to verify that test/fixture/runner paths are absent.
