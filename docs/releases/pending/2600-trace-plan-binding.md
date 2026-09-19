---
issue: 2600
title: Bind the issue trace to its loaded plan and surface silent trace stalls
---

## What changed

- **Plan binding (fail-closed):** the issue-trace engine now binds the loaded plan to the current spec before it may drive EXECUTE. `WorkflowArtifacts` carries `planBoundToSpec` — the hook computes it as "the authoritative plan's recorded `specHash` equals the current effective spec's SHA-256" (the same hash `save_plan` captures at save time). A plan whose `specHash` differs (or predates spec linkage) parks the trace with a one-shot `PLAN_BINDING_GATE` directive naming the recovery (re-save the plan against the current spec, or `/swarm reset` — which also deletes `.swarm/spec.md` and the recorded review receipts, so re-run `/swarm issue --trace` afterwards). The gate re-arms on later sentinels, so a spec edited mid-trace re-nudges instead of stalling silently. A critic-approved plan for issue X can no longer execute under a trace for issue Y.
- **Fewer silent stalls:** reducer rows (d) (spec/trace mismatch) and (g) (critic not approved) now emit one-shot directives instead of bare no-ops — row (g) names the `approve_plan_critic` / `/swarm approve-plan-critic` recovery for the #2012 recorder-miss class. A new `REPRO_GATE_LATE` row makes the reproduction gate reachable when a plan already exists (it used to live only inside the no-plan branch and was structurally skipped). One deliberate silence remains: while the spec has no parseable `## Source Issue` (mid-generation), row (d) stays quiet — nudging there would contradict the ingest transition in progress.
- **Non-trace hygiene:** `/swarm issue` without `--trace` no longer writes an `in_progress` `issue-trace-state.json` (the engine ignores non-trace references); pre-existing trace state is left untouched. `--trace` still persists both artifacts.
- **Non-vacuous recurrence gate:** `dispositions: []` — and a receipt with the `dispositions` key omitted — is rejected for a real defect class by both the receipt reader and `record_recurrence_sweep` (an empty sweep is indistinguishable from one that never ran; a real defect class always has at least the original defect site, dispositioned FIX). The "no defect class" fast path is unchanged.
- **Skill text reconciled:** the bundled issue-ingest skill's `trace=true` transition text now describes the actual gating (a fresh trace transitions to PLAN when no plan exists and the freshness/reproduction gates permit; a foreign or unbindable plan parks with the binding directive) instead of promising an unconditional automatic `[MODE: PLAN]`.

## Why

Issue #2600 (Workstream F, DD-C001/DD-C002/DD-C005/DD-C009/DD-C008): with a critic-approved plan for issue X on disk, `/swarm issue Y --trace` silently executed plan X under trace Y with every gate skipped; several wait states stalled with zero signal; and non-trace invocations left misleading `in_progress` trace records on disk. Verified against the 2026-09-06 deep-dive audit and re-verified at the fix base (`eddf6e1fb`) by direct execution of the production modules.
