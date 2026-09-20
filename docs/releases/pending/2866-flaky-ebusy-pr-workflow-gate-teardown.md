# Root-fix the shared PR-workflow fixture teardowns' Windows EBUSY flake (#2866)

## Why

`dispatch-lanes-pr-review-micro-cycle.test.ts` — and any of the 48 suites
sharing the fixture — intermittently failed on Windows in
`teardownPrWorkflowGateFixtures`: the shared teardown removed its temp
project directory with an unguarded, zero-retry `fs.rm` immediately after
`closeAllProjectDbs()`, so a transient directory-handle holder (just-closed
SQLite handle release lag, AV scan, indexer) made the removal throw
`EBUSY`/`EPERM`/`ENOTEMPTY` out of `afterEach`, failing a test whose own
assertions had already passed. Reproduced naturally at 2 failures in 20
standalone runs on win32 (bun 1.3.14); Windows unit shards and the merge
queue are exposed to the same race. This is the #1782 cold-FS/AV-handle
teardown class previously retired file-by-file for
`pr-monitor-status.test.ts` (#2190) and
`index-pr-workflow-session-lifecycle-2602.test.ts` (#2807/#2809).

## What changed

- `teardownPrWorkflowGateFixtures`
  (`tests/unit/hooks/pr-workflow-gate.test-fixtures.ts`, 48 consumer
  suites) and `createPublicationFixture().teardown`
  (`tests/unit/hooks/pr-workflow-publication.test-fixtures.ts`, 7 consumer
  suites) now remove their temp directories through the repository's
  canonical `safeRmRecursive` helper: containment proof, per-directory
  project-db handle release, and a bounded 20×100 ms retry on
  EBUSY/EPERM/ENOTEMPTY that still throws once the window is exhausted, so
  genuine handle leaks keep failing suites.
- The publication fixture's now-unused `node:fs/promises` import is
  removed.
- `tests/unit/hooks/pr-workflow-checkout-bootstrap.test.ts` (same unguarded
  teardown shape, found by the class sweep) gets the same one-line
  retirement.
- New guardrail `tests/unit/hooks/pr-workflow-gate-teardown-ebusy-2866.test.ts`
  pins both directions of the contract: teardown rides out a directory
  holder released inside the bounded window (Windows) and still throws
  transiently when a holder outlives the window; plain teardowns still
  remove their directories on every platform.

POSIX behavior is unchanged. Windows worst case adds at most the bounded
retry window to a teardown that would previously have failed the suite
outright.
