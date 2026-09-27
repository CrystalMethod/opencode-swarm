# Phase gates key on stable phase id with label fallback

## What changed

- Knowledge-receipt memberships now carry an optional numeric `phase_id`, and
  every phase-keyed receipt read matches it first: the phase-complete
  critical-directive gate, phase close/intent stamping, and terminal-batch
  phase checks. A displayed-label change between injection and completion (the
  plan cursor legitimately advancing mid-phase, or a phase status flip on
  save) can no longer empty the gate's evidence window — an unresolved
  critical directive now blocks `phase_complete` instead of silently passing,
  closures stamp the right rows, and closed rows become compaction-eligible.
- Legacy records without `phase_id` keep verbatim-label behavior; reads also
  fall back to the id parsed from their immutable stored label.
- `/swarm doctor` gains a `knowledge-receipt-phase-id` check (detection
  always-on, fail-open on a busy ledger lock) and `/swarm doctor --fix` can
  backfill ids from stored labels. `repair_knowledge_receipt_ledger` gains
  `operation: 'backfill_phase_id'` for on-demand repair. The backfill is
  journaled (`phase_id_backfilled` records), idempotent, and never rewrites a
  stored label.
- When the gate blocks across a label change, the block message names the
  phase id and both labels (bounded), so the skew is visible.
