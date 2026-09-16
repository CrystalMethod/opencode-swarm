# Correct Stage A coder-mutation guidance

## What

Stage A guardrails now distinguish a missing accepted coder mutation from a
genuine attribution-recovery failure, including the audited no-change recovery
path for tasks whose Stage B proof shows that no code change was required.

## Why

When a task is `rework_required` because Stage B did not require a code change
and a fresh green `pre_check_batch` proof exists, the architect may use the
audited architect-only `recover_rework_task` path with the exact task ID and
reason. Genuine defects still require coder repair; block only when neither
path applies. Attribution failures retain `/swarm recover` guidance.

## Migration

No migration is required. This is an internal guardrail message correction;
workflow persistence and command behavior are unchanged.
