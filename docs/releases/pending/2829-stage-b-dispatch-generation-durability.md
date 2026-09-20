# Stage B dispatch-generation binding durability (issue #2829)

## What

- **Durable twin for the Stage B dispatch-generation bindings.** `stageBDispatchGenerationsByCallID` (`src/hooks/delegation-gate.ts`) was a closure-local map: a plugin reload or host restart between dispatch and settlement lost it and every post-restart foreground Stage B settlement arrived `unbound` and was dropped fail-closed (visible since #2817, unrecoverable). `rememberStageBDispatchGenerations` now also persists the binding at dispatch time into a new store `.swarm/stage-b-dispatch-bindings/<sha256(sessionID).slice(0,24)>/<callID>.json` (new module `src/background/stage-b-dispatch-binding-store.ts`; atomic write via `atomicWriteSwarmFileSync`, hashed path component — the raw sessionID never touches the path; schema version + identity cross-check + TTL-validated fail-closed reads).
- **Post-restart settlement reconstruction.** When the in-memory lookup misses, the settlement path reads the durable twin and feeds the RECONSTRUCTED generation into the EXISTING `expectedGeneration` fence (`transitionTaskWorkflowEvidence`): a generation-fresh binding settles exactly as an in-process one; a stale binding still dies on `TASK_WORKFLOW_GENERATION_MISMATCH` (AGENTS.md invariant 9 — never the reverse); a missing/corrupt/partial record keeps today's fail-closed `unbound` drop. Per-task lookup mirrors the in-memory shape (`bindings.find(taskId).generation`) — one record's tasks settle independently.
- **Bounded and evicted.** Dispatch-time writes are non-fatal (the in-memory map remains the primary fence) and overrun-guarded (~50 ms budget, debug-gated log); the store is bounded by per-session file cap (mirrors `MAX_PENDING_CODER_CHANGE_CONTEXTS`), a 128-session-dir LRU ceiling, and a 24 h TTL prune. All three existing in-memory cleanup paths (`backgroundCompletionClaimed`, coder settlement, teardown, denied-dispatch abort) now also delete the durable record; `/swarm reset` clears the whole store recursively (mirroring `summaries/`) and `/swarm reset-session` clears the invoking session's subtree.
- **Truthful advisory.** The `unbound` drop advisory now says "no durable binding was found for this dispatch, so it cannot be reconstructed" — still naming the process-local/restart cause — instead of claiming reconstruction is impossible outright.

## Why

Issue #2829 tracks #2817's option (b): the #2830 observability half made the drop visible; this is the durability half that closes the recovery loop. The fail-closed DECISIONS were already correct everywhere; the missing piece was the proof path that lets a genuine post-restart settlement demonstrate generation freshness without re-running the gate.

## Notes

- New store registered in `WRITER_CLASSIFICATION` (`src/utils/atomic-write.ts`, `migrated` — it writes through the canonical `atomicWriteSwarmFileSync`); no new temp-file grammar.
- Restart simulation in the regression suites uses only the public API: two hook closures over one session (the second closure is exactly the post-restart shape), a real durable record from the first closure's dispatch.
- Reviewer/test-engineer background dispatches (opt-in `background_subagents`) take the same per-call write budget — skipping durable twins for those lanes would reintroduce the drop for exactly the long-running dispatches most exposed to restarts; no double-durability hazard exists (coder slot reservations gate concurrency admission, the generation fence gates settlement freshness — orthogonal).
- Guardrails: two new suites (store unit tests + restart-fresh/restart-stale/crash-window/eviction/advisory gate slices) plus the unchanged #2817 suites pinning the no-binding drop.
