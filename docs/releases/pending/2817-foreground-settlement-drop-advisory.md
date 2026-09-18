# Foreground Stage B settlement drops are now session-visible (issue #2817)

## What changed

When a clean reviewer/test_engineer verdict arrived in the foreground Stage B parallel settlement path but was dropped by a fail-closed fencing condition, the drop was silent — only a debug-gated `logger.warn` (invisible without `OPENCODE_SWARM_DEBUG=1`), leaving the task wedged at its current state with no recovery signal. The worst case was structural: the dispatch-generation binding is process-local, so after a plugin reload or host restart between dispatch and settlement **every** foreground settlement was silently discarded as "unbound".

Dropped settlements now surface on two channels (mirroring the background delegation path's `[BACKGROUND COMPLETION ...]` advisories):

- a session advisory — `[stageb-settlement-drop:<reason>:<task>] STAGE B SETTLEMENT DROPPED: <agent> task <id> from call <call>: <detail>` — naming the task, the drop reason, and the remedy (re-dispatch the gate), queued via `pushAdvisory` (dedupe + cap, issue #1976). The unbound case names the restart/process-local cause explicitly. The rejection-persistence leg gets distinct wording (inspect `.swarm/` evidence storage and retry the rejection transition — the verdict need not be re-earned).
- an ungated `criticalWarn` host-log line, aggregated to one line per drop class per settlement invocation (no per-task stderr flood), so the drop survives in host logs under every configuration.

All five silent drop legs in the settlement loop are covered: unbound launch generation, route-receipt enforcement blocked, route-evidence capacity, gate-evidence fencing rejection (e.g. `TASK_WORKFLOW_GENERATION_MISMATCH`), and rejection-persistence failure.

## What did NOT change

The fail-closed drop decisions themselves. Dropped settlements still record no gate evidence and leave the task state unchanged (AGENTS.md invariant 9 fencing, per the #2814 fix). This change is observability only.

## Adjacent open work

Durable persistence of Stage B dispatch-generation bindings across restarts (the issue's option (b)) remains open and is tracked as a follow-up; the restart-aware advisory names re-dispatch as the remedy until then. Same defect family as #2814 (background path, fixed) and #2828 (recover/check_gate_status Stage A disagreement, open).
