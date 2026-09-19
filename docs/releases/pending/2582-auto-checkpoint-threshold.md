---
title: Implement the automatic checkpoint threshold (checkpoint.auto_checkpoint_threshold)
issue: 2582
---

## What changed

`checkpoint.auto_checkpoint_threshold` (int 1-20, default 3) finally has the runtime reader its schema description has promised since v6.4: when a task transitions to `completed` through the plan status funnel, the plugin counts the plan's completed tasks and, each time the count reaches a multiple of the configured threshold, records one automatic checkpoint in `.swarm/checkpoints.json` with a deterministic label (`auto-task-checkpoint-<plan-identity>-<count>`). Before this change the setting was fully validated but inert — tuning it changed nothing (#1691 removed its only reader, which had misused it as a retention cap, and reserved it for this trigger).

## How it behaves

- **Cadence**: `auto_checkpoint_threshold: 2` checkpoints at 2, 4, 6... completed tasks; `3` at 3, 6, 9... — the default of 3 applies when the key is absent.
- **Retention stays separate**: `checkpoint.max_retention` (default 20) continues to bound the log independently, and automatic entries are evicted FIFO exactly like manual ones; the threshold never acts as a retention cap.
- **`checkpoint.enabled: false`** disables the automatic trigger (manual `checkpoint` tool actions are unchanged).
- **Non-fatal with visible failures**: a failed automatic checkpoint (lock contention, unwritable log, label conflict) emits an always-visible warning and never blocks the durable task-status update; cadence skips (disabled / below boundary) stay silent.
- **Restorable only**: the trigger skips directories that are not git repositories OR have no commits yet (unborn HEAD) — an entry without a restore SHA is dead FIFO weight; manual `checkpoint save` still records with a warning there.
- **Replacement-plan collisions**: if a prior entry already holds the deterministic label for this plan identity and completed count (a restarted count after a re-plan, or a surviving prior-epoch entry), the new boundary saves under a `-g2`, `-g3`, ... generation suffix instead of being dropped; a replay or racing concurrent save at the same commit SHA is a quiet no-op (manual labels that merely share the prefix are never mistaken for automatic entries).
- **Advisory**: a crash between the durable status write and the trigger loses that transition's checkpoint; it is not re-attempted on restart.

## Verification

Cadence matrices at thresholds 1/2/3 through the real completion funnel, retention independence under `max_retention: 2`, `enabled: false`, non-git skip, non-fatal injected failure, and a repo-wide guardrail test that fails if any `CheckpointConfigSchema` key ever ships again without a runtime reader (`tests/unit/config/checkpoint-config-consumption-2582.test.ts`).
