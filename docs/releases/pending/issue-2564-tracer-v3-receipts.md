# Wire issue-tracer v3 receipts plugin-side and prove issue ingestion reaches a durable plan (issue #2564)

## What

- **Branch-freshness receipt (v3 Phase 0)**: new `record_branch_freshness` tool writes
  `.swarm/branch-freshness.json` (`synced` / `behind:<n>` / `fetch-failed:<reason>` plus an
  optional verbatim user override). The reader mirrors `trace-check.sh phase0` exactly —
  `behind` and a bare `fetch-failed` fail closed; only a recorded override rescues a failed
  fetch — and the reducer parks the trace with a one-shot `FRESHNESS_GATE` directive before
  the PLAN transition until the receipt permits.
- **Per-phase validator receipts**: new `record_trace_validation` tool records each
  `trace-check.sh phase <N>` outcome (phase enum 0..5, pass/fail, reviewedCommit + treeId,
  both 40-hex) into `.swarm/trace-validation.json`, upserting per phase. The reducer's new
  `TRACE_VALIDATION_GATE` blocks the commit-pr handoff while any recorded phase is failing
  or none is recorded.
- **Widened recurrence-sweep receipt**: `record_recurrence_sweep` now requires
  `relatedProblems` — the Phase 1 related-problems sweep results, at least one
  `{ref, note?}` entry — on both the real-defect-class and "no defect class" paths, and the
  reader enforces the widened shape non-vacuously (missing key / empty array / blank refs no
  longer satisfy the gate).
- **Merge-approval receipt (v3 Phase 5.1)**: new `record_merge_approval` tool records the
  human merge approval bound to the exact PR head (`prHeadSha === finalCriticReviewedCommit`,
  both 40-hex; mismatch rejected at write time) with the approval quoted verbatim. The trace
  gains a true terminal `merge_approval_recorded` status after `published` — RECORDED, NEVER
  CERTIFIED: `nextMode` stays null and the directive names the human as the merge authority,
  inheriting trace-check.sh's "human-enforced gate; presence and binding only" posture.
- **Journey proof**: new end-to-end tests drive a real `/swarm issue <N> --trace` input
  through `handleIssueCommand`, the real receipt tool executors, the real ledger
  (`savePlan`/`loadPlan` — plan tasks carry acceptance criteria, files, and requirement
  references), the real `approve_plan_critic` path, an interruption/resume step (module
  cache resets), the gates ladder, publication, and the merge-approval recording — no
  `_internals` behavioral overrides.

## Why

Issue #2564: the issue-tracer v3 protocol's gates were enforced only by the skill text and
`scripts/trace-check.sh` — the plugin-side reducer, state adapter, and receipt tools knew only
the v2-era artifacts, so the runtime could neither observe nor enforce the v3 receipts, and no
test wired the ingestion command, the real receipt tools, and the reducer together.

## Migration notes

- A recurrence-sweep receipt recorded before this change (v2 shape, without `relatedProblems`)
  no longer satisfies the recurrence gate. An in-flight trace that already fired its recurrence
  one-shot will wait quietly; re-running `/swarm issue <N> --trace` resets the trace state and
  re-arms every gate, and the widened receipt is then recorded with `relatedProblems`. A
  load-time receipt migration is deliberately out of scope here (#2566 owns validator,
  portability, and migration follow-ups).
- `TraceStatus` grows `merge_approval_recorded`; state readers normalize unknown legacy
  statuses to `in_progress` exactly as before, and `published` alone remains a valid resting
  state until a merge-approval receipt is observed.

## Verification

- Frozen acceptance checks C1-C9 (arm's-length authored, red-checkpointed at base
  `b865ba262`): all RED/ERROR at base, all GREEN post-fix; PRESERVING checks C6/C8 stayed
  GREEN throughout (v2-shaped reducer literals stay transparent — the new gates fire only on
  explicit `false`).
- The reducer remains a pure, model-agnostic module (no imports, no runner/model/host routing
  anywhere in the trace engine).
