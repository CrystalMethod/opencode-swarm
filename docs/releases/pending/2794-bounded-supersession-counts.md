---
issue: 2794
---

# Bounded supersession counts for restart recovery

## What

Adds the counts-only `plan_recovery_superseded` telemetry event (issue #2794, the F-004 follow-up from the #2777/#2668 review): every snapshot-coordination initialization attempt that settles superseded now emits exactly one event carrying a within-process cumulative `count` and a closed two-value `trigger` vocabulary (`plan_recovery` = the typed `PlanRecoverySupersededError` path; `coordination_fence` = any generation-fence outcome). The events land in the existing `.swarm/telemetry.jsonl` stream and the `observability_event` SQLite sink, so counting occurrences across restarts distinguishes a one-off recovery from repeated restart flapping. Attempts settling under the deliberate-reset closing guard are excluded (maintenance is not flapping).

## Why

Before this change, supersession was detected and handled but left no countable trace anywhere: no telemetry kind existed, and the only surface (`/swarm status` coordination state) is last-writer-wins transient state that dies with the process. An operator could not tell whether a superseded attempt was the first in a week or the fortieth today.

## Notes

- Process-local vs durable (per the issue): the count is both — a process-local scalar carried in every payload, and a durable per-occurrence event in the two stores every `emit()` already feeds. No new store, writer, or retention-registry row.
- Reachability, candidly: the single class of production trigger for a counted supersession is a superseding `beginHydrationScope` arriving mid-attempt — today that means a later `loadSnapshot` for the same root (precisely the race the #2777 review's F-001 left open). An empty trail means no supersession was observed, not that the mechanism is unreachable.
- The counter instruments the settlement chokepoint in `src/session/snapshot-coordination-init.ts` (exactly once per attempt), not the `src/plan/manager.ts` rethrow fences — those are transport and would multi-count.
- Operator docs: the event-contract catalog row (§ plan) and a recovery-runbook note on counting occurrences.
