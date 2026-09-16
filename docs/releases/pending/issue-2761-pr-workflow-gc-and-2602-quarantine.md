# Quarantine two merge-group flaky tests (issue #2761)

## What changed

- Appended one new entry to the general/global CI quarantine ledger,
  `scripts/ci/quarantined-tests.txt`:
  - `tests/unit/hooks/pr-workflow-gate-batch-gc.test.ts`
    (cross-OS unit-shard 1 hard failure, all 3 in-job attempts
    timed out under merge-group pressure; CORE-TREE entry — see
    the dedicated justification in the ledger comment block)
- Appended one new entry to the Windows-only CI quarantine ledger,
  `scripts/ci/quarantined-tests-windows.txt`:
  - `tests/unit/index-pr-workflow-session-lifecycle-2602.test.ts`
    (windows-latest unit-shard 5 passed-on-retry-2 flake)
- The general-ledger file now has 3 active entries (this entry joins the
  issue #2740 evidence-summary-adversarial and issue #2660 init-rehome
  entries that landed on `main` after this branch was cut). The
  Windows-ledger `STATUS:` header is bumped from 3 to 4 active
  entries.
- Each entry carries the structured `# OWNER:` / `# EXPIRY:` metadata
  block required by `scripts/check-invariants.ts` Check 7 (issue
  #2477), so the entries hard-fail the gate if the EXPIRY lapses
  beyond the 14-day grace window and is not renewed.
- No source, hook, or workflow code changed. The change is confined
  to the two ledger files and this pending release fragment.

## Why

Issue #2761 was auto-filed by the `flake-detection` workflow (issue
#1782, introduced by the merge-group flake-detection phase §6) after
a merge-group CI run (`ci.yml` run 34797415390, head
`15dcd7f1731c9e380bf7fbddb95252bca095cf6d`, started
2026-09-14T01:54:24Z) was processed by flake-detection run
34799399563 at 2026-09-14T02:29:49Z (issue #2761 filed 12 s later
 at 2026-09-14T02:30:01Z). The issue body listed:

```
# CORE-TREE (requires human review): tests/unit/hooks/pr-workflow-gate-batch-gc.test.ts
tests/unit/index-pr-workflow-session-lifecycle-2602.test.ts
```

Tracing the detection job back to its upstream CI run (via the
`run-id: 34797415390` log line in `flake-detection.yml` —
`.github/workflows/flake-detection.yml:62`), I cross-referenced the
per-shard `flake-annotations-*` artifacts (downloaded from
`.github/workflows/flake-detection.yml:60-65`, see also the
`scripts/ci/detect-and-quarantine-flakes.sh:180` fallback) against
the CI run's `unit (RUNNER_OS, SHARD)` jobs:

- `tests/unit/hooks/pr-workflow-gate-batch-gc.test.ts` — CORE-TREE
  entry, hard failure. The file's `flake-annotations-unit-shard-1`
  artifact (id 10331335105, 258 bytes, created 2026-09-14T02:29:05Z
  on workflow_run 34797415390) carries:
  `::error file=tests/unit/hooks/pr-workflow-gate-batch-gc.test.ts::FAILED: tests/unit/hooks/pr-workflow-gate-batch-gc.test.ts`.
  This is the `::error file=...::FAILED` annotation printed by
  `scripts/ci/run-unit-tests-local.ts` / `.github/workflows/ci.yml`
  only after both retries are exhausted (the script prints
  `::warning file=...::Attempt N failed, retrying` per attempt and
  then `::error file=...::FAILED` if `exit_code -ne 0` after
  `max_retries=2`), meaning **all 3 in-job attempts of this file
  failed** under merge-group pressure. The originating job's log is
  no longer queryable from the actions API (only the artifact
  remains), so per-OS attribution is indirect via the artifact's
  presence on `flake-annotations-unit-shard-1` rather than
  `flake-annotations-unit-shard-{N}` of a specific OS. The file is
  genuinely cross-OS timing-sensitive (the file header at
  `tests/unit/hooks/pr-workflow-gate-batch-gc.test.ts:35-42`
  declares "every test here builds a full cap's worth of batches,
  which is inherently slow: ~4s against bun's 5000ms default, i.e.
  flaky by construction, and a timeout mid-transaction poisons the
  *next* test (its continuation writes into a temp directory
  teardown already replaced)" — the test deliberately sets
  `CAP_TEST_TIMEOUT_MS = 60_000` per-test to give itself headroom
  against the same cold-FS pressure that has hit prior merge-group
  runs), so the general ledger is the correct target rather than
  per-OS. The CORE-TREE rule C of
  `scripts/ci/detect-and-quarantine-flakes.sh:130` would normally
  drop this candidate; the human-review justification is recorded in
  the ledger comment block itself (per the recipe's CORE-TREE
  precedent — "for the core-tree hooks test, either fix the
  instability or document why quarantine is appropriate before
  adding it"; the comment block documents the why).
- `tests/unit/index-pr-workflow-session-lifecycle-2602.test.ts` —
  Windows-only retry-flake. The `flake-annotations-unit-shard-5`
  artifact (id 10331065544, 282 bytes, created
  2026-09-14T02:27:26Z on workflow_run 34797415390) carries:
  `::notice file=tests/unit/index-pr-workflow-session-lifecycle-2602.test.ts::Passed on retry 2 (flaky): tests/unit/index-pr-workflow-session-lifecycle-2602.test.ts`.
  The unit job that produced this artifact is `unit (windows-latest, 5)`
  (job 103839563148, started 2026-09-14T02:03:19Z), and its log
  records the full attempt trace at
  `2026-09-14T02:16:24.5589336Z` (`##[warning]Attempt 1 failed,
  retrying (1/2)`) →
  `2026-09-14T02:16:28.4210387Z` (`##[warning]Attempt 2 failed,
  retrying (2/2)`) →
  `2026-09-14T02:16:32.5718635Z` (`##[notice]Passed on retry 2
  (flaky)`). Sibling shards (ubuntu 1-6, macos 1-6, and the other
  five windows unit shards 1/2/3/4/6) were green on this file in the
  same CI run. The Windows-only sensitivity is consistent with the
  Windows cold-FS / AV-handle class already documented for
  `tests/unit/commands/pr-monitor-status.test.ts` (issue #1982,
  root-fixed by PR #2190) and `tests/unit/sandbox/win32-wrapper-runtime.test.ts`
  (issue #2185). Windows ledger is the correct target.

Local reproduction on this checkout (per the recipe's local-pass
gotcha, run under a clean `TMPDIR`):

```
TMPDIR=~/.cache/hermes-tmp bun test \
  tests/unit/hooks/pr-workflow-gate-batch-gc.test.ts \
  tests/unit/index-pr-workflow-session-lifecycle-2602.test.ts \
  --timeout 120000

 10 pass
 0 fail
 43 expect() calls
Ran 10 tests across 2 files. [27.09s]
```

The tests pass locally (the flake is environment-sensitive — merge-group
OS matrix / coverage context — not a logic bug, exactly per the
quarantine rationale). Notably, the `pr-workflow-gate-batch-gc` suite's
longest cell "the validation batch cap is reclaimed in a reviewer retry
loop" already takes 10915.95 ms locally, very close to the default
5000 ms bun:test timeout the file header warns about; under cold-FS
merge-group pressure (4-7× slower on Windows runners, 2-2.5× on
ubuntu-latest vs. local) the same cell routinely exceeds the
`CAP_TEST_TIMEOUT_MS = 60_000` per-test budget the file sets itself, and
all three in-job attempts time out.

The triage comment on issue #2761
(`https://github.com/ZaxbyHub/opencode-swarm/issues/2761#issuecomment-5663243526`)
claims both files "could not be located by content search" — this is
stale text written at comment-draft time. Both files are present in the
working tree (`ls -la tests/unit/hooks/pr-workflow-gate-batch-gc.test.ts tests/unit/index-pr-workflow-session-lifecycle-2602.test.ts`
returns the expected files with non-zero size), and the recipe
explicitly flags this gotcha ("User-comment drift on file existence")
at `references/flaky-test-quarantine.md` §Gotchas, citing issue #2761
itself as the confirmed case.

## Migration steps

No migration required. The change is additive to the CI's existing
quarantine ledgers; it does not modify any code, hook, command, tool,
or runtime contract. Consumers of the published plugin are unaffected;
CI's unit job will continue to skip these two files (the
`scripts/ci/quarantined-tests*.txt` files have always been filtered
out of unit-job test discovery per `.github/workflows/ci.yml`).

## Known caveats

- The `pr-workflow-gate-batch-gc` entry is CORE-TREE (tests under
  `tests/unit/hooks/**`); rule C of
  `scripts/ci/detect-and-quarantine-flakes.sh` would normally drop
  it, and the human-review justification in the ledger comment block
  is what unblocks the entry. The expected retirement paths in the
  EXPIRY clause are: (a) shrink `MAX_WORKFLOW_BATCHES` for
  these tests via a test-only override (e.g. seed minimal fixtures
  so the full-cap loop is unnecessary), or (b) raise the per-test
  timeout floor used by merge_group windows-latest /
  ubuntu-latest cold-FS shards. Both are tracked under the
  test-stability sprint (`#1782`).
- The `index-pr-workflow-session-lifecycle-2602` entry is Windows-
  only and shares the cold-FS / AV-handle class already root-fixed
  for `tests/unit/commands/pr-monitor-status.test.ts` via PR #2190
  (commit `ec1ad2901`, `safeRmRecursive` with closed project-db
  handle + bounded EBUSY/EPERM retries in
  `tests/helpers/safe-test-dir.ts`). The expected retirement path
  is the same: route the test's teardown through `safeRmRecursive`.
  A sibling quarantine PR (#2809, branch
  `auto-fix/issue-2807-auto-detected-flaky-tests-merg-5c5519`)
  root-fixes the file rather than quarantining it
  (commit `45c664602`); if that PR merges to
  `origin/main` before the EXPIRY date the entry can be retired
  preemptively under the root-fix precedent (#1982 / PR #2190
  pattern). The wrapper may merge either approach first — textual
  conflicts on this branch are the wrapper's concern, not a blocker.
- A sibling `auto-fix/issue-2807` branch already root-fixes
  `tests/unit/index-pr-workflow-session-lifecycle-2602.test.ts`
  (commit `45c664602`); if that PR merges to `origin/main` first,
  the windows-ledger entry for this file is moot and should be
  removed on first merge. The wrapper can detect this via
  `git log --merges --ancestry-path <fix-sha>..HEAD` to confirm the
  root-fix carrier PR's identity, then remove the entry on the
  PR that supersedes this one.

Refs: #2761 (this issue), #1782 (flake-detection workflow),
#1737 (test quarantine debt — historical; closed), #2477 (OWNER/EXPIRY
metadata grammar enforced by Check 7), #1982 (Windows-only ledger
precedent with the same root-fix retirement pattern via PR #2190),
#2185 (Windows-only ledger precedent sharing the cold-FS / AV-handle
class), #1729 (historical Windows-quarantine retirement that paid
down the issue #1737 debt), #2602 (the upstream PR-workflow
lifecycle issue this regression test was added for, closed via
PR #2726), #1908 (general-ledger retirement precedent).
