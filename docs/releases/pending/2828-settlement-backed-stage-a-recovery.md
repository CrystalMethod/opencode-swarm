# Settlement-backed Stage A recovery for idle/blocked wedges

## Summary

- **The wedge (issue #2828):** a task with a COMMITTED accepted coder
  settlement and green post-settlement `pre_check_batch` proof could sit with
  `stage_a_passed` never recorded — Stage B dispatch refused with
  `TASK_WORKFLOW_STAGE_A_REQUIRED` and `update_task_status(completed)` failed
  on missing gates — while every recovery path refused:
  `/swarm recover` (and `--force`) answered "nothing to repair" because the
  workflow label (`idle` after a force-repair cleared the gate proofs, or
  `blocked`) sat outside its `coder_delegated`-only wedge predicate;
  `recover_rework_task` requires exactly `rework_required`;
  `repair_gate_evidence` cannot write workflow transitions; and a coder
  re-dispatch produces no mutation, so Stage A could never be re-attributed.
  `check_gate_status` and `/swarm recover` read different stores and no
  reconciler existed for the disagreeing combination.
- **Fix — reconcile on the durable receipts:** the Stage A wedge scan
  (`repairWedgedStageA` / `scanWedgedStageA`) recognizes a new
  `settlement_wedge` class: workflow `idle` or `blocked` while a COMMITTED
  settlement WAL with `accepted: true` and green post-settlement secretscan +
  sast_scan bundles still justify Stage A. `/swarm recover <task_id>`
  deterministically writes the missing `stage_a_passed` (never re-runs the
  coder, never edits gate evidence) and the classifier reports
  `settlement_wedge` with repair guidance instead of `healthy`.
- **Fix — audited escape hatch:** new architect-only `recover_stage_a_task`
  tool (`src/workflow/settlement-recovery.ts`) writes the same audited
  transition for agent-driven recovery, with a required sanitized reason,
  session-architect check, idempotent no-op when Stage A is already recorded,
  and a `stage_a_repair` audit event carrying `via: recover_stage_a_task`
  plus predecessor linkage. Its durable predicates are exactly the
  deterministic repair's (evidence at `idle`/`blocked` + COMMITTED accepted
  settlement + green post-settlement bundles) — deliberately no
  plan-membership precondition, matching the `/swarm recover` scan it mirrors
  (an extra plan.json refusal would re-create the wedge class this recovery
  removes).
- **State machine:** `stage_a_passed` gains a guarded entry mode — the
  `settlementRecovery` event flag admits it from `idle` and `blocked` (the
  terminal guard gains exactly one exception for `blocked` + this flag).
  Every other emitter still fails closed with
  `TASK_WORKFLOW_CODER_MUTATION_REQUIRED` / `TASK_WORKFLOW_TERMINAL`. The
  marker persists in the workflow evidence (distinguishable from a mechanical
  pass, like `supervisedRecovery`) and is cleared when a new generation opens
  (`repair_idle`, `accepted_mutation`).
- **Fail-closed preserved:** without the COMMITTED accepted settlement or
  without green post-settlement proof, idle/blocked tasks are still refused
  with a pointed reason naming the receipts and the escape hatch; the
  existing `coder_delegated` live_wedge repair and its WAL-less fallback are
  unchanged. Background-dispatched coders never write a settlement WAL, so
  the new class is unreachable for them by construction. `--force` still
  affects only in-process settlement-WAL ownership and never overrides Stage
  A wedge-classification refusals (now stated in `/swarm recover`'s docs).
