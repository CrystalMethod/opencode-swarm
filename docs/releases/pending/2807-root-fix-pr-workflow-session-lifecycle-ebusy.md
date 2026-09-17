# Root-fix the #2602 regression test's Windows EBUSY teardown flake (#2807)

## What changed

`tests/unit/index-pr-workflow-session-lifecycle-2602.test.ts` (the regression
test for the deleted-owner / foreign-gate PR-workflow lifecycle fix of issue
#2602) now cleans up its temp project directory in `afterEach` via the
repository's canonical `safeRmRecursive` helper (`tests/helpers/safe-test-dir.ts`)
instead of a bare `rmSync(directory, { recursive: true, force: true })`.

- Import change: `rmSync` from `node:fs` is removed; `safeRmRecursive` is
  imported from `../helpers/safe-test-dir.js`.
- `afterEach` now calls `safeRmRecursive(directory)`. That helper:
  - calls `closeProjectDb(directory)` (best-effort; a no-op when no cached
    handle exists) before removing the tree, releasing the cached
    `.swarm/swarm.db` WAL handle the plugin opened under the project identity
    (issue #2480), and
  - retries `EBUSY`/`EPERM`/`ENOTEMPTY` with bounded backoff (up to 20
    attempts, 100 ms each), the Windows AV-handle race class documented by
    issue #1782.
  - refuses to remove anything outside `os.tmpdir()` (including `os.tmpdir()`
    itself) before touching the filesystem.
- The pre-existing `expect(getOpenProjectDbCount()).toBe(0)` assertion stays in
  `afterEach` (it still verifies the db handle is released after
  `plugin.hooks.dispose()` — now it also documents the ordering precondition
  for the cleanup).

## Why

Flake-detection (issue #1782) filed issue #2807 for this file: merge-group CI
run 35077355769, `unit (windows-latest, 2)` attempt 1, the file failed all
three executions (initial run + 2 retries) with

```
EBUSY: resource busy or locked, rm 'C:\Users\RUNNER~1\AppData\Local\Temp\swarm-e2e-1849-*'
  at <anonymous> (tests/unit/index-pr-workflow-session-lifecycle-2602.test.ts:45:3)
```

i.e. the afterEach `rmSync` racing a still-held `.swarm/swarm.db` WAL handle on
windows-latest — the same #1782 class the repository already root-fixed for
`tests/unit/commands/pr-monitor-status.test.ts` (PR #2190, `ec1ad2901`). All
sibling OS/shards were green in that run, and the flake is not a logic bug: the
fix restores the same guarded teardown pattern the test suite standard
(`writing-tests` skill: "Clean up temp dirs ... with a bounded helper ...
Reuse `tests/helpers/safe-test-dir.ts` when possible") mandates for exactly
this case. Root-fixing keeps the #2602 regression coverage active on all
platforms rather than suppressing it with a quarantine entry.

## Migration steps

None. This is a test-only change; no runtime behavior, config, or API changes.

## Known caveats

- The fix is validated on Linux locally (4/4 pass, plus the 31-test
  `ci-yml-integration` suite); the flake itself is windows-latest-specific and
  cannot be reproduced on this host, so the definitive proof is the next
  merge-group windows-latest run. If the file flakes again on that platform,
  the remaining cause would be a handle held beyond `dispose()` and should be
  re-localized with the attempt-1 job log (`##[group]Output for ...`).
- No quarantine entry was added for this file (the root fix is the preferred
  outcome per the issue's triage comment); if a recurrence is observed the
  flake should be re-triaged under the test-stability effort (#1782).
