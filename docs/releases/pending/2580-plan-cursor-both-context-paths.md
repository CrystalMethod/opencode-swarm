issue: 2580
---

## What changed

- The `plan_cursor` configuration block (`enabled`, `max_tokens`,
  `lookahead_tasks`) is now actually honored. Previously it was accepted by the
  schema and documented, but no production code read it — every setting was
  silently ignored (dead advertised config, audit finding CONFIG-F-02).
- Both context-injection paths now share one resolver
  (`resolvePlanCursorControls`, src/hooks/extractors.ts):
  - Path A (default, non-scoring): `enabled: false` suppresses the
    `[SWARM PLAN CURSOR]` injection; `max_tokens` and `lookahead_tasks` now
    shape the emitted cursor.
  - Path B (opt-in `context_budget.scoring`): same gates and options — and the
    scoring path now emits the plan-cursor candidate at all. It previously
    produced none for any real workspace shape, because its plan.md read lived
    in a branch that only executes when the structured plan fails to load,
    while `loadPlan` migrates a markdown-only plan into a structured Plan. It
    also gains the same `DISCOVER`-mode suppression Path A already had.
- The context budget report's `planCursorTokens` now accounts for the cursor
  that is actually injected (routed through `extractPlanCursor` with the same
  controls; exactly 0 when the cursor is disabled) instead of a bespoke
  30-line/1000-char approximation that no code path ever injected.
- Docs corrected: disabling the cursor keeps the phase header and current-task
  context injections (the real pre-v6.13 behavior). The old claim that
  disabling "falls back to injecting the entire plan text" described behavior
  that never existed and is removed from README.md and docs/architecture.md.

## Why

Issue #2580 (Workstream F, PR 16 of 21): accepted user controls must reach both
the normal and the scoring plan-cursor extraction paths; canonical token
accounting must stay consistent. With an absent `plan_cursor` block the default
(non-scoring) path's cursor text is byte-identical to the previous release, so
no migration is needed. Two observable default-config deltas are intentional:
opt-in scoring sessions now receive the plan-cursor candidate they were always
documented to have (it was structurally absent), and the budget report's
`planCursorTokens`/`swarmTotalTokens` now count the actually-injected cursor
(~2.5x the old never-injected approximation on the regression fixture), so
budget percentages may shift slightly downward or upward toward the truth.
Out-of-range values are clamped to the schema bounds (500-4000 tokens, 0-5
lookahead tasks).

## Verification

- Frozen acceptance checks C1-C12 (issue-tracer red checkpoint): disabled /
  default / enabled cases on both context paths, lookahead and token-budget
  effects, Path B candidate presence with a valid structured plan, budget
  report zeroing and canonical accounting, docs claim removal, and this
  fragment — all RED-to-GREEN at the fix commit.
- New regression suite `tests/unit/hooks/system-enhancer-plan-cursor-config-2580.test.ts`
  plus resolver unit tests in `tests/unit/hooks/plan-cursor.test.ts`; adjacent
  system-enhancer and budget suites re-run green.
