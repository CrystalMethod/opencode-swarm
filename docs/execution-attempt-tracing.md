# Execution-Attempt Tracing and Task-Cost Cohorts (issue #2676)

This document defines the event vocabulary, the frozen-manifest schema, the
cohort inclusion rules, and the boundary between descriptive operational counts
and causal-rate claims introduced by issue #2676 (Workstream D16). The event
kind itself is catalogued in `docs/observability-event-contract.md`
(`#### execution_attempt_recorded`); this page owns the deeper contracts.

## 1. Event vocabulary

Every execution attempt is ONE `execution_attempt_recorded` telemetry event
(producer `src/observability/execution-attempt.ts`), bound to the exact
identity the producer holds:

| Payload field | Meaning |
| --- | --- |
| `sessionId` | host session (maps to envelope `hostSessionId`) |
| `taskId`, `callId`, `invocationId` | the exact task / tool-call / invocation join axes (envelope correlation axes since #2676) |
| `generation` | monotonic cursor for the (task, call) pair; REQUIRED on `late` records |
| `retryIndex`, `laneId`, `knowledgeTraceId` | optional joins carried when held |
| `attemptClass` | the closed class vocabulary below |
| `outcomeStatus` | `success` / `failure` / `partial` / `unknown` — `unknown` is a reported fact, never a guess |
| `captured`, `unknown` | explicit capture-coverage lists over join + cost fields |
| `cost` | the per-attempt cost block (§3) |
| `duplicateOf` | the original record's identity — REQUIRED on `duplicate`, never synthesized |

### Closed attempt classes

| Class | Meaning | Production producers today |
| --- | --- | --- |
| `attempt` | a dispatch started; nothing about outcome is known yet | delegation begin (`emitDelegationBegin`) |
| `result` | a completed call's outcome record | delegation terminal (`emitDelegationCostObservation`), Stage A `valid_pass` |
| `denial` | a gate refused before a task outcome existed | Stage A `pre_check_failed`, `invalid_result`, `no_task_correlation`, `attribution_ambiguous` |
| `duplicate` | an idempotent re-arrival of an already-committed record | Stage A `duplicate_result` (with `duplicateOf` = the call's record identity) |
| `late` | a record arriving after a later generation | Stage A `late_result` (with its `generation` cursor) |
| `cancelled` | the attempt was cancelled | delegation terminal `cancelled` |
| `provider_failed` | a provider/transient failure classified at the failure boundary | fixture-only today — no production seam currently holds the classification at emit time; the class exists so a producer can never guess it |

`result` at the Stage A seam means "completed gate-tool-call outcome" (routes
fire at `toolAfter` completion), not "delegation lifecycle terminal"; both are
completed-call outcome records. Attempts are NEVER inferred from repeated
training strings or from tool output without its invocation identity — the
joins above are the only accepted evidence.

Enforcement is fail-open (the Stage A route-event pattern): a class outside
the closed vocabulary, a `late` record without its generation cursor, a
`duplicate` without an original identity, or a missing session identity is
logged warn-only and dropped — it never corrupts the lifecycle it observes.

## 2. Unknown is not zero

The per-attempt cost block (`buildTaskAttemptCost`) carries EXACTLY six axes:
`latencyMs`, `inputTokens`, `outputTokens`, `cacheReadTokens`,
`estimatedCostUsd`, `billedCostUsd`. Each axis is `number | null`:

- an axis the producer did not hold is strictly `null` AND listed in the
  block's `unavailable` array;
- a known axis passes through verbatim and is never listed;
- zero is a legal KNOWN value (zero tokens used) and is never produced as a
  fallback for missing input.

`estimatedCostUsd` vs `billedCostUsd` maps onto the existing cost-evidence
distinction: `cost_source: 'estimated'` fills the estimated axis,
`'reported'` fills the billed axis, `'unavailable'` leaves both null. At the
delegation terminal seam, token axes are carried only when the provider's own
payload attested usage (`cost_source: 'reported'` — the pinned SDK shapes
carry cost and usage together; the synthesized missing-cost evidence item
zero-fills usage and would otherwise leak in as a known zero). An estimate-only
chain carries its estimated dollar value but leaves the token axes unknown.
The legacy `delegation_end` fold zero-defaults absent usage on its own surface
(a pre-existing conflation tracked by a filed follow-up; the new surface never
routes through it). `cacheReadTokens` carries the provider's combined
cache read+write total at that seam because the upstream axis collapses the
two (also disclosed there).

Historical unavailable fields remain unknown: records emitted before an axis
was captured are never back-filled.

## 3. Frozen manifest schema

`snapshotTaskAttemptCohort` (`src/observability/task-cohort.ts`) captures,
BEFORE the population snapshot is returned, one bounded provenance manifest
per source:

```json
{
  "source": "trigger | wal | event | host_status",
  "status": "captured | unavailable",
  "capturedAt": "<ISO-8601>",
  "sizeBytes": 12345,
  "digest": "<sha-256 of the first 64 KiB>"
}
```

- `trigger` → `.swarm/events.jsonl`, `wal` → `.swarm/knowledge-receipts-v2.jsonl`,
  `event` → `.swarm/telemetry.jsonl`, `host_status` → runtime/plugin version facts.
- Digests are SHA-256 over the FIRST 64 KiB (bounded read); every filesystem
  touch is try/catch fail-open to `status: "unavailable"` — a missing source
  is an explicit fact, never a synthesized digest.
- When the snapshot is given a project `directory`, it persists ONE frozen
  manifest JSON under `.swarm/observability/cohorts/` (FIFO retention: the
  latest 20 files; write failures are warn-only). Retention owner: #2676.

## 4. Cohort inclusion rules and qualification

A cohort is the DEEP-COPIED population captured at `capturedAt`. Later
mutation of the caller's array or of nested record fields cannot change the
snapshot or any report built from it: the reported `denominator` is the
captured count, never a live recount.

`buildTaskCohortReport` computes per-class counts, per-axis cost totals over
records that HELD the axis (unknown axes contribute nothing), per-axis
unavailable counts, and an `uncertainty` channel that is non-empty whenever:

- the sample is below the threshold (30), or
- any cost axis is unavailable on any record, or
- any record lacks an outcome status.

`qualification` is `false` with enumerated reasons when the cohort cannot
support a causal-rate claim: empty population, no configuration/version
stratum at all, or an uncaptured manifest source.

## 5. Operational counts vs causal-rate claims

- **Descriptive operational counts** summarize what was observed in a window
  (the `/swarm report` pairing and savings sections; unqualified cohort
  sections). They make no comparative or causal statement.
- **Causal-rate claims** assert that a rate changed because of something. They
  are permitted ONLY on a `qualified` cohort report: stable snapshot,
  explicit denominator, configuration/version strata, and disclosed
  uncertainty. Mutable live-session populations are snapshotted with
  timestamps or remain explicitly unqualified — there is no third state.
