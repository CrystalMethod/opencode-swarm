# Execution-attempt tracing and task-cost cohorts (issue #2676)

## What changed

- **New `execution_attempt_recorded` observability event** (65th catalogued
  kind): ONE event per execution attempt, bound to the exact task, call,
  invocation, and generation identity the producer holds, with a closed
  attempt-class vocabulary (`denial` / `attempt` / `result` / `duplicate` /
  `late` / `cancelled` / `provider_failed`), explicit capture coverage
  (`captured` / `unknown` lists), and a per-attempt cost block whose unknown
  axes are strictly `null` plus an `unavailable` list entry — never `0`.
- **Envelope correlation axes `callId` + `invocationId`** added to
  `WorkflowIdsSchema` (13 → 15 recognized IDs): exact-call and invocation
  joins are now first-class correlation axes; Stage A callers' PascalCase
  `sessionID`/`callID` are normalized at the recorder.
- **Producers wired**: the delegation lifecycle begin/terminal observers
  (classes `attempt`, `result`, `cancelled`; latency from the dispatch start,
  tokens only when the cost-evidence chain held usage, estimated-vs-billed
  from `cost_source`) and the Stage A gate route hook (classes `denial`,
  `result`, `late` with the correlation's threaded generation cursor, and
  `duplicate` — production `duplicate_result` routes stay fail-open drops
  because the seam holds no original record identity; the class is recordable
  when a caller supplies `duplicateOf`).
- **Cohort machinery** (`src/observability/task-cohort.ts`): a DEEP-copied
  population snapshot with `capturedAt` (post-snapshot mutation cannot change
  a reported denominator), frozen provenance manifests for the trigger /
  WAL / event / host-status sources (bounded 64 KiB digests; missing sources
  are explicit `unavailable`), configuration/version strata, a computed
  `uncertainty` channel (present whenever the sample is below threshold, any
  cost axis is unavailable, or any outcome is missing), and an explicit
  causal-rate `qualification` verdict. Snapshots persist one bounded
  FIFO-20 manifest under `.swarm/observability/cohorts/` (retention-registry
  row `observability-cohorts`).
- **`/swarm report` gains a "Task attempts (cohort)" section** (`--json`
  schema version 2): per-class counts, cost known/unavailable split,
  uncertainty, and the qualification line. Existing pairing/savings sections
  are unchanged and documented as descriptive operational counts.
- **Docs**: `docs/execution-attempt-tracing.md` defines the event vocabulary,
  manifest schema, cohort inclusion rules, and the operational-counts vs
  causal-rate-claims boundary; the event contract doc gains the kind section
  and the two new correlation axes.

## Why

Execution traces and task-cost measurements could not support causal claims
about retries, quality, latency, or cost: records were joined only at
session/task level (the call identity died at the envelope boundary),
denial/attempt/result/duplicate/late had no shared representation, unknown
token counts collapsed to zero in the legacy fold, and no cohort machinery
existed to qualify aggregate claims. Issue #2676 (Workstream D16).

## Disclosed residual

The legacy `delegation_end` fold (`src/telemetry.ts` token `?? 0` defaults;
`src/services/cost-accounting.ts` `readNumber(...) ?? 0`) still zero-defaults
absent usage on ITS surface — a pre-existing conflation tracked by a filed
follow-up issue. The new `execution_attempt_recorded` surface is immune by
construction and never routes unknowns through that path.
