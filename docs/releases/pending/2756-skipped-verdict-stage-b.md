# Stop test_runner's dead-end scope advice and score TESTED SKIPPED as retryable, not failed

Issue: #2756

## What changed

- **`test_runner` remediation text** (`src/tools/test-runner.ts`): the guard that rejects `scope:"convention"`/`"graph"`/`"impact"` without `files`/`targets` no longer recommends `scope:"all"` — the exact scope its sibling guard blocks for agent use (env-gated `SWARM_ALLOW_FULL_SUITE`) and the `test_engineer` prompt prohibits. The `message` field now directs the caller to pass a non-empty `files` array (or `targets` for framework-native names) with a concrete example. The `error` field text and both guards' semantics are unchanged.
- **Foreground Stage B verdict settlement** (`src/hooks/delegation-gate.ts`): a `[TESTED] | task-N | SKIPPED | ...` structured verdict (tests were NOT run — prohibited scope, framework detection none, missing test file) no longer emits `stage_b_failed`. The task stays in its Stage B eligible state (`reviewer_run`/`pre_check_passed`), the reviewer's APPROVED gate proof is preserved, and the `stageBCompletion` entry is untouched, so the architect can re-dispatch the test gate instead of forcing a coder rework of correct code. A warn log records the skip for the orchestrator. Genuine `FAIL` verdicts and `REVIEWED` rejections keep the existing `stage_b_failed` → `rework_required` semantics.
- **Background Stage B ingestion** (`src/background/stage-b-gates.ts`): `structuredStageBVerdict` now returns `'skip'` for TESTED SKIPPED; `ingestBackgroundStageBCompletion` consumes the record with the new `skipped: true` result flag and fires no transition and no proof clearing. `StageBIngestionResult` gains the optional `skipped` field.
- **Background advisory** (`src/background/completion-observer.ts`): a skipped ingestion publishes `skipped (tests not run) — re-dispatch the test gate; reviewer proof preserved; task remains Stage B eligible` instead of the generic `ingestion failed`, so operators can distinguish a retryable skip from a hard failure.

## Why

An agent that followed the tool's own advice (`scope:"all"`) could not succeed — the recommended scope is blocked — and models without a natural `files:` habit (observed: Kimi K2.7 Code, 10–11 identical calls) looped until the repetition breaker fired. The prompt's SKIP CONDITION 1 then legitimately produced a `[TESTED] ... SKIPPED` verdict, which the gate scored as a code failure: `rework_required` plus deletion of the reviewer's approval for code that was correct and passing (`python -m pytest` green). Together with #2755 (no autonomous exit from `rework_required`, fixed by PR #2760's audited recovery tool), a single tool-argument mistake stranded tasks that only a human could free. This fix removes the wrongful entry: tests-not-run is retryable state, not failure.

## Tests

- `tests/unit/tools/test-runner-scope-advice.test.ts` — guard-2 message directs to files/targets and never recommends the blocked scope (all three guarded scopes); guard-1 block and the pinned `error` text are characterized as unchanged.
- `tests/unit/hooks/delegation-gate-stage-b-skipped.test.ts` — SKIPPED leaves state `reviewer_run` with durable reviewer proof and the reviewer completion entry intact; FAIL and REVIEWED REJECTED still go `rework_required` with proof cleared.
- `tests/unit/background/stage-b-gates-skipped-verdict.test.ts` — SKIPPED ingest returns `skipped: true`, no state mutation, proof preserved; FAIL and unparseable output keep the fail-closed rejection.
