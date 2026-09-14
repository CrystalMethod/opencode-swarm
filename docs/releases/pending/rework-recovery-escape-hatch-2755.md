# rework_required gains an architect-only audited exit (issue #2755)

- **New `recover_rework_task` tool (architect-only).** A task stranded at
  `rework_required` by a Stage B verdict that did not require a code change
  (e.g. a SKIPPED verdict scored from a tool-argument mistake) can now be
  returned to Stage B dispatch without re-running the coder. The tool writes
  a supervised `stage_a_passed` for the task's current generation and appends
  a `stage_a_repair` audit event (action `rework_recovered`, with the
  sanitized reason) to `.swarm/events.jsonl`; the durable transition id is
  prefixed `rework-recovery:` so a supervised recovery stays distinguishable
  from a mechanical Stage A pass.
- **Fail-closed preconditions.** Requires the active session to be the
  architect, the exact plan task id, durable workflow state exactly
  `rework_required`, and green pre-check proof for the wedged generation
  (both secretscan and sast_scan bundles green and newer than the failure
  transition — the same #2665 bar the Stage A wedge repair uses). Every
  refusal is a distinct typed error (`RECOVER_REWORK_*`, `PLAN_*`).
- **Mechanical guardrail unchanged.** The reducer admits `stage_a_passed`
  from `rework_required` only when the new `supervisedRecovery` event flag is
  set, which only this tool sets. The guardrails recorder and the
  `/swarm recover` wedge scan are untouched: a genuine code defect still
  requires an accepted coder mutation before Stage A passes again, and the
  automatic repair scan still skips `rework_required` tasks.
- **Truthful dispatch remediation.** The `TASK_WORKFLOW_STAGE_A_REQUIRED`
  refusal for reviewer/test_engineer dispatch now branches on state: from
  `rework_required` it names `recover_rework_task` (and the coder repair loop
  for real defects) instead of the human-only `/swarm recover`; the
  attribution-wedge guidance (`coder_delegated` after `/swarm reset-session`)
  keeps the `/swarm recover` advice where it actually applies.
