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
  fall back to the id parsed from their immutable stored label. The stable id
  only ever EXTENDS matching — it never narrows what the pre-upgrade
  label-only reads would have returned, so obligations recorded in the window
  after a phase's last task completes (when the plan cursor has already
  advanced) still gate that phase's completion.
- `/swarm doctor` gains a `knowledge-receipt-phase-id` check (detection
  always-on and fail-open on a busy ledger lock) and `/swarm doctor --fix` can
  backfill ids from stored labels. `repair_knowledge_receipt_ledger` gains
  `operation: 'backfill_phase_id'` for on-demand repair (ledger-wide;
  `phase`/`session_id` do not scope it). The backfill is journaled
  (`phase_id_backfilled` records), idempotent, and never rewrites a stored
  label.
- When the gate blocks across a label change, the block message names the
  phase id and both labels (bounded), so the skew is visible. When the labels
  agree but the recorded obligation carries a different phase id (the
  closing-window shape), the message names the recorded phase id instead.
- Upgrade note: this is a one-way migration once any `phase_id`-bearing record
  exists — downgrading to a pre-`phase_id` build after that makes the receipt
  journal unreadable (the old parser rejects the new field). Receipt journals
  written by older builds remain fully readable after upgrading. The journal
  schema version stays 2 intentionally: the new field is optional and the
  strict per-record parsers (not the version gate) are what make old records
  replay unchanged.
