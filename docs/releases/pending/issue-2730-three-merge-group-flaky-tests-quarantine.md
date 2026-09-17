# Quarantine the last issue-#2730 merge-group flaky test (pr-feedback-scope-controller) and pin no-duplicate ledger state

## What changed

- Appended one new entry to the macOS-only CI quarantine ledger,
  `scripts/ci/quarantined-tests-macos.txt`:
  - `tests/unit/hooks/pr-feedback-scope-controller.test.ts`
    (macos-latest unit-shard 1, passed-on-retry flake)
- The other three candidates listed by issue #2730 were already
  quarantined by the time this PR landed, so it deliberately does NOT
  duplicate them (the flake-detection script's Rule A drops
  already-quarantined candidates; a second entry would be a confusing
  same-path duplicate with two OWNER/EXPIRY blocks competing for
  renewal ownership):
  - `tests/unit/scripts/ci/repository-validation-real-process-2675.test.ts`
    — macOS ledger, via issue #2738 (commit `ad8c53ae3`, 2026-09-12)
  - `tests/unit/utils/bun-compat-exit-first-2530.test.ts`
    — macOS ledger, via issue #2740 (PR #2769, merged 2026-09-17)
  - `tests/unit/telemetry/init-rehome.test.ts`
    — general ledger, via issue #2660 (PR #2799, merged 2026-09-17;
    the general ledger is the only one the ubuntu-only coverage job
    honors)
- The new entry carries the structured `# OWNER:` / `# EXPIRY:`
  metadata block required by `scripts/check-invariants.ts` Check 7
  (issue #2477), so it hard-fails the gate if the EXPIRY lapses beyond
  the grace window and is not renewed.
- Added a 14-test pinning regression file
  (`tests/unit/scripts/ci/ci-yml-quarantine-2730.test.ts`) covering the
  new entry (ledger placement, scope isolation, OWNER/EXPIRY metadata,
  on-disk path presence) and asserting the no-duplicate invariant for
  the three already-owning candidates: each path appears exactly once,
  in its owning ledger only.
- No source, hook, or workflow code changed. The change is confined to
  the macOS ledger file, the new pinning test file, and this pending
  release fragment.

## Why

Issue #2730 was auto-filed by the `flake-detection` workflow (issue
#1782) after a merge-group CI run (`ci.yml` run 34670762927, head
`1499a74b`, 2026-09-12) reported four candidate paths. This PR is the
human review that issue's CORE-TREE marker requires.

For the new entry, the per-shard evidence is single-OS:
`tests/unit/hooks/pr-feedback-scope-controller.test.ts` — macos-latest
unit-shard 1 (`Attempt 1 failed, retrying (1/2)` → `Passed on retry 1
(flaky)` at 2026-09-12T03:56:04Z). All sibling macos shards (2/4/5/6),
all ubuntu unit shards (1-4), and all windows unit shards were green on
this file or did not run it by shard round-robin distribution. The
macOS ledger is the correct target, and the general ledger would
over-suppress the file on ubuntu/windows.

The ci.yml retry loop discards attempt-1 output when a retry passes,
so no assertion text exists to drive a root-cause fix for this file.
Local reproduction passes (8/8 cases; the three-issue candidate set
runs 21 pass / 0 fail together), which is the expected quarantine
rationale: the flake is environment-sensitive (merge-group runner
timing), not a logic bug.

The three already-quarantined candidates were dispositioned by their
owning issues: #2738 for the #2675 signal test, #2740 (PR #2769) for
the bun-compat probe, and #2660 (PR #2799) for init-rehome — the last
two merged while this PR was in review, which is why this PR's final
scope is one new entry plus the dedup pins instead of three entries.

## Migration steps

None. The macOS ledger is honored by the existing
`scripts/ci/run-unit-tests-local.ts` (`bun run test:unit:ci`) consumer
and by the macOS branch of the quarantine step in `ci.yml` (line 632).
After this commit merges, subsequent merge-group CI runs will skip
`pr-feedback-scope-controller.test.ts` in the macOS unit job only.

## Known caveats

- **Quarantine is not a fix.** The entry suppresses flake-induced red
  shards in CI but does not address the underlying environment
  sensitivity. Retirement should be pursued under a test-stability
  effort; the original sprint (issue #1782) is closed, so open a
  follow-up issue when scheduling the work.
- **`scripts/check-invariants.ts` Check 7 timeline.** The EXPIRY below
  is set 30 days out. Check 7 is silent while an EXPIRY is in the
  future; once an EXPIRY lapses it warns for the 14-day grace window
  and hard-fails on day 15 past the date. If the underlying flake
  persists past EXPIRY, the entry must be renewed with an updated
  criterion (or the test root-fixed) to keep CI green.
- The new entry is single-OS: macOS-latest merge-group flake with
  green sibling shards. If a future flake-detection run produces
  cross-OS evidence for this file, move the entry to the general
  ledger — the live precedent is issue #2660's `init-rehome.test.ts`
  general-ledger entry (PR #2799), quarantined after an ubuntu
  coverage-shard flake.
- The `init-rehome.test.ts` entry owned by #2660 sits in the general
  ledger rather than a per-OS ledger, which means it also suppresses
  that file in macOS/Windows unit-job runs. That is pre-existing
  two-ledger architecture (`ci.yml` reads the general ledger
  unconditionally; `run-coverage-gate.sh` never branches per-OS), not
  introduced by this PR.
- Sibling auto-fix branches held overlapping quarantine entries while
  this PR was open; the collision was resolved by rebasing onto main
  and keeping only the entry this PR owns (see "What changed").

Refs: issue #2730, issue #1782 (flaky-test detection workflow),
issue #2477 (OWNER/EXPIRY metadata grammar enforced by Check 7),
issue #2738 (the #2675 macOS-ledger entry this PR defers to),
issue #2740 (PR #2769, the bun-compat macOS-ledger entry),
issue #2660 (PR #2799, the init-rehome general-ledger entry).
