---
issue: 2581
---

# TODO gate: wire evidence production to the configured completion gate

## What

The `todo_gate` configuration (`enabled` / `max_high_priority` /
`block_on_threshold`) was declared in the config schema and documented, but
nothing implemented it: no code read the config, no producer wrote `todo_scan`
evidence, and no phase-completion path could warn or block. This wires the full
producer → evidence → consumer path (#2581, audit finding CONFIG-F-03):

- **Producer**: `todo_extract` accepts an optional `task_id` (N.M format).
  When provided and `todo_gate.enabled` is not `false`, the scan records its
  high-priority (FIXME/HACK/XXX) count as a `todo_scan` field in
  `.swarm/evidence/{task_id}.json` — priority, count, per-entry `file:line`
  details (capped at 50, labeled when truncated), and a `recorded_at`
  timestamp. The scan output itself is unchanged; recording never fails the
  tool. `todo_extract` is now also granted to the `coder` agent so the repair
  path is actionable where the comments are introduced.
- **Evidence schema**: `TaskEvidence` (TS + zod) carries the optional
  `todo_scan` field, and `updateEvidenceForTransition` now carries
  supplementary fields (`todo_scan`, and the previously-dropped
  `repair_provenance` / `requirements_state`) through workflow transitions —
  producer output survives every subsequent evidence write.
- **New write API**: `recordTodoScanEvidence` performs a supplementary
  no-event write through `withTaskEvidenceTransaction` (same lock + atomic
  write discipline), fenced by `assertTaskEvidenceWriteAllowed` so a producer
  cannot clobber an in-flight coder settlement or terminal commit.
- **Consumer `check_gate_status`**: applies the configured threshold to the
  recorded evidence. Above threshold → advisory line in `message` (default), or
  `status: incomplete` + a `todo_gate (BLOCKED — N high-priority TODOs exceed
  max M)` missing-gate entry when `block_on_threshold: true`. Config-load
  failure skips TODO evaluation (debug-logged) instead of fabricating a
  verdict.
- **Consumer `phase_complete`**: a new `todo_gate` standard preflight gate
  evaluates every phase task's recorded evidence — warns (advisory) or blocks
  (with the per-entry `file:line` evidence and a recovery step naming
  `todo_extract` with the `task_id`). No recorded evidence anywhere → pass with
  zero warnings; `enabled: false` → plain pass; plan-load failure, absent
  phase, or corrupt per-task evidence never block.
- **Shared evaluator** (`src/todo/todo-gate.ts`): one pure implementation of
  the threshold semantics (exceeded ⇔ count > max; `0` warns on any
  occurrence; `-1` disables) used by both consumers, so they cannot disagree.
- **Docs**: the `todo_gate` section in `docs/configuration.md` now describes
  the implemented producer/consumer contract (replacing the
  unimplementable "introduced during a phase" phrasing) and states the
  re-run requirement for refreshing point-in-time evidence.

## Why

Users set these controls in the wild (see the #872 config sample) and the
plugin accepted them while silently doing nothing — an advertised gate that
can neither warn nor block. The issue's constraint "avoid a new gate that can
block without an available producer" is honored structurally: both consumers
key exclusively off recorded `todo_scan` evidence.

## Verification

- 5 new unit suites (evaluator matrix, phase gate behaviors incl. multi-task
  ANY predicate / plan-failure / corrupt-evidence / advisory-vs-blocking,
  producer recording incl. disabled no-op and preservation, check_gate_status
  consumer incl. secretscan coexistence, transition preservation incl.
  `repair_provenance`).
- Existing `todo_extract` + `check_gate_status` suites stay green; frozen
  issue-tracer acceptance checks C1–C8 GREEN (base RED replay recorded).
