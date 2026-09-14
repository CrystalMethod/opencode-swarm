# Plan-critic task attribution fix (#2757)

## What changed

Plan-level critic-family dispatches no longer acquire a durable per-task gate
merely because review prose mentions a plan task ID. `critic`,
`critic_sounding_board`, `critic_drift_verifier`, `critic_hallucination_verifier`,
and `critic_architecture_supervisor` now require structured task attribution or
an exact task marker at launch, background pending capture, and foreground
settlement. A non-strict named ID cannot shadow a valid numeric marker. Reviewer
and test-engineer plan-aware routing is unchanged, including explicit task
routing for large plans.

The architect delegation contract now instructs task-scoped dispatches to keep
the numeric plan ID consistent across the `TASK:` line and `task_id` argument.

## Recovery

Existing projects with already-orphaned critic gate evidence should use the
audited `repair_gate_evidence` recovery path. The fix does not rewrite durable
evidence automatically.

## Migration

No configuration change is required. Task-scoped critic dispatches must carry a
structured task ID or an exact task marker such as `TASK: 1.1`.
