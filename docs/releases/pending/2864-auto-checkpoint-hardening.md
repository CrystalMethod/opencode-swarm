---
title: Harden the automatic checkpoint trigger (events, unbounded generations, documented fallbacks)
issue: 2582
---

## What changed

Follow-up hardening for the `checkpoint.auto_checkpoint_threshold` trigger shipped in #2864, addressing the post-merge review findings:

- **Observability**: successful automatic checkpoints now emit a `checkpoint_auto_saved` event to `.swarm/events.jsonl` (same stream as `checkpoint_retention_applied`), so trigger firings are visible in the event log.
- **No more generation exhaustion**: replacement-plan label collisions (`-g2`, `-g3`, ...) are no longer capped at 20. The generation space is unbounded and the loop always terminates, so a plan can no longer get permanently stuck emitting only an "exhausted" warning.
- **Documented fallbacks**: an invalid `auto_checkpoint_threshold` (0, negative, non-integer — only reachable through config-recovery paths) falls back to the schema default of 3 rather than disabling the trigger, and skips (no git repo / no commits yet) remain silent by design. Both behaviors are now documented in the release notes and pinned by tests.

## Verification

New trigger-level tests cover the previously untested branches (config-loader failure fallback, git-spawn failure, non-hex rev-parse output, malformed checkpoints log, generations beyond 20), funnel tests now assert the default cadence, `skipReason` outcomes, the worktree-merge skip, and the new event; the consumption guardrail ignores comment text so a reader-deleting refactor can no longer pass vacuously; funnel tests isolate the developer's user-level config.
