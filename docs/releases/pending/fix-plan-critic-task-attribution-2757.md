# Plan-critic task attribution fix (#2757)

## What changed

Plan-level `critic` and `critic_sounding_board` dispatches no longer acquire a
durable per-task gate merely because review prose mentions a plan task ID.
Those roles now require structured task attribution or an exact task marker at
launch, background pending capture, and foreground settlement. Reviewer and
test-engineer plan-aware routing is unchanged, including explicit task routing
for large plans.

## Recovery

Existing projects with already-orphaned critic gate evidence should use the
audited `repair_gate_evidence` recovery path. The fix does not rewrite durable
evidence automatically.

## Migration

No configuration change is required. Task-scoped critic dispatches must carry a
structured task ID or an exact task marker such as `TASK: 1.1`.
