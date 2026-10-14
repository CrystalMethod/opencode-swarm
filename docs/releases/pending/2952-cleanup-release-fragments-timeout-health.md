---
title: Restore release-pipeline cleanup health — timeout covers wait budgets + a workflow timeout lint
issue: 2952
---

# Restore release-pipeline cleanup health (issue #2952)

The `cleanup-release-fragments` release job no longer kills itself mid-wait on every
release: its `timeout-minutes` now covers the sum of its own dispatched-run wait budgets
(with round-trip overhead and margin), the ci.yml wait's poll budget now outlasts the
dispatched run it waits for, and a new static lint keeps the invariant enforced on every
workflow-touching PR.

## What changed

- **Wait budgets scaled to their targets** (`.github/workflows/release-and-publish.yml`):
  `wait_for_dispatched_run` takes per-call poll parameters (`fn <workflow> <iterations>
  <sleep_seconds>`, defaults preserved at 120×5 s). The ci.yml wait now polls up to
  30 min (360×5 s — the dispatched ci.yml run observed 16m05s against the old 10-minute
  poll budget), and the pr-standards/drift-check waits stay at 10 min. Each call site
  declares its realistic duration via a `# target-duration: <minutes>` comment.
- **Job timeout covers the sum**: `cleanup-release-fragments` `timeout-minutes` 10 → 70.
  The old value sat below every wait's effective cost once the observed per-iteration
  `gh run list` round-trip overhead is counted (600 s nominal vs ~660-720 s effective
  per wait), and 3-3.6× below the 50-minute sum (3,000 s declared → 3,900 s required at
  the 1.2× overhead factor plus margin); every release run was cancelled at ~10 minutes
  mid-wait, `release-health-summary` went red, and each run stranded a cleanup PR
  awaiting manual rescue.
- **New static lint** `scripts/check-workflow-timeouts.ts` (invoked as
  `bun run scripts/check-workflow-timeouts.ts`, the exact form CI runs): for every job
  that polls via a seq×sleep wait loop, asserts
  `timeout-minutes ≥ ceil(Σ wait budgets × 1.2) + 5 min` and every wait budget ≥ its
  declared `# target-duration`. Fail-closed throughout: parameterized helpers with
  `${N:-default}` defaults resolve; unresolvable defaults, expression-valued timeouts,
  inline (non-function) poll loops, oversized files, and unattributable constructs are
  all findings, never silent passes — and the same holds for parser ambiguity
  (unparsable job regions, unterminated wait functions, line-continued loops, empty
  scans, and findings overflow all fail closed). A wait call site without a
  `# target-duration` directive is a violation (deliberate strengthening: every wait
  must declare its target).
- **CI wiring**: the lint runs in the `drift` job of `drift-check.yml` (pull_request,
  push, merge_group, workflow_dispatch) via direct script invocation — the same
  pattern as the drift check step beside it. A `package.json` script alias is not
  added: the release-owner guard (#2677) forbids non-release PRs from touching
  `package.json`.
- **Tests** (`tests/unit/scripts/check-workflow-timeouts.test.ts` plus
  `tests/unit/scripts/check-workflow-timeouts-robustness.test.ts`): 34 tests covering
  the pre-fix red shape, the fixed green shape, the exact shipped parameterized helper
  (anti-vacuousness: the lint demonstrably sees the workflow it ships with, and a
  dropped-directive mutation reds), all fail-closed findings (including non-literal
  wait-call arguments), partial parameterization, parser edges, the parser-hardening
  regressions (commented `jobs:` keys, alternate job indentation, commented or missing
  function braces, line-continued loops, comment-shadowed budgets, empty scans,
  truncated output), and a ratchet over the repository's real workflows.

## User-visible effect

On the next release after this lands, `cleanup-release-fragments` should conclude
`success` and `release-health-summary` should be green instead of failing with
"cleanup-release-fragments concluded cancelled"; the docs/releases archive materializes
automatically and the per-release manual rescue of `chore/release-fragments-*` PRs ends.
