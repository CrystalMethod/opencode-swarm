# Restart preserves tightened runtime policy and reconciles interrupted work

## What changed

- Session-scoped ratchet-tighter QA gate overrides (`/swarm qa-gates
  override`) are now durable runtime policy: a new project-DB table
  (`qa_gate_session_override`, full durability class) is written
  durable-first by the command and restored by `rehydrateState`, so a host
  restart preserves the effective tightened gates instead of silently
  reverting to the spec-level profile. The override row is deleted in
  lockstep with the session (explicit end, 2-hour stale sweep,
  `/swarm reset-session`), and a session with no tightened gates keeps no
  row.
- The `get_qa_gate_profile` tool now also reports the calling session's
  overrides and the **effective gates** (profile merged with those
  overrides), so an agent can inspect effective runtime policy after a
  restart through the registered surface.
- An execution interrupted by a process boundary (serialized
  `delegationActive: true`) now reconciles to a bounded, owner-named
  outcome instead of expiring silently: a durable artifact
  (`.swarm/session/restart-reconciliation.json`, 50-entry FIFO deduped by
  session+task) plus a one-shot advisory on the restored session, both
  naming the owning session, agent, and task and classifying the outcome as
  interrupted/UNKNOWN — absence is never treated as success. Ephemeral
  authority still expires exactly as before; only the silence was a defect.
- New operator documentation (`docs/restart-reconciliation.md`): the
  durable-vs-ephemeral field classification for the restart boundary, the
  operator-visible reconciliation states, the restart/inspect runbook, and
  the human-resolution rule for external effects.

## Why

Issue #2668 (Workstream D slot D15): restart needed to preserve durable
workflow and QA policy while discarding ephemeral execution authority, and
the previously silent expiry of interrupted work left "was interrupted
mid-execution" indistinguishable from "was idle" — an operator could not
tell uncertain from clean, and a valid tightened policy was lost on every
restart.

## Tests

- `tests/unit/db/qa-gate-session-override.test.ts` — service contract:
  ratchet-only merge, fail-closed malformed rows, clear idempotency,
  empty-overrides invariant, absent-DB read-only behavior.
- `tests/unit/session/restart-policy-reconciliation.test.ts` — boundary
  contract: override survives rehydrate (and a double restart), new sessions
  start clean, fail-open restore, owner-named reconciliation artifact +
  advisory, dedupe, bounded cap, both teardown paths delete the durable row.
- `tests/unit/tools/get-qa-gate-profile-effective.test.ts` — effective-gates
  tool surface (executor + registered schema fields).
- `tests/unit/execute-journey/j08-restart-policy.test.ts` — registered-host
  journey: boot A tightens through the real command and dies mid-execution;
  boot B (fresh `server()` over the same durable artifacts) preserves the
  tightened effective gates via `get_qa_gate_profile` and records the
  owner-named reconciliation.
