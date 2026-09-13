# Normal EXECUTE journey — host qualification (issue #2666)

This document defines the qualification fixture family for the **normal
EXECUTE journey** — the non-PR-review path a swarm runs every day — and the
evidence needed to call a run complete. PR-review journey breadth is owned
by #2585/#2586 and is intentionally out of scope here.

## Journey state machine

The normal EXECUTE journey composes these stages and durable receipts:

| Stage | Driving surface (registered) | Durable receipt(s) |
|---|---|---|
| configure | `chat.message` hook (agent-turn identity) | session state + later snapshot; structured hook receipt in the journey report |
| discover | `repo_map` tool (build + ask) | `.swarm/repo-graph.json` when persisted; structured tool result |
| specify | `save_plan` tool | `.swarm/plan.json`, `.swarm/plan-ledger.jsonl` |
| approve | `approve_plan_critic` tool + `get_approved_plan` binding | ledger `snapshot` event with `payload_hash`; QA gate profile |
| EXECUTE | `declare_scope` tool, then the native `task` tool simulated through the merged `tool.execute.before`/`after` hook chain (guardrails + delegation gate) with the host's `event`-hook child-session correlation (`message.part.updated` tool part) | `.swarm/evidence/{taskId}.json` (`accepted_mutation`), `.swarm/coder-settlements/{taskId}.json`, scope binding |
| pre-check (Stage A) | `pre_check_batch` tool through the full hook chain | evidence `stage_a_passed` + `stage_a_gate_route` event (`.swarm/events.jsonl`) |
| reviewer (Stage B) | `task` simulation with `[REVIEWED] \| task-N.M \| APPROVED/REJECTED/CONCERNS \| …` | evidence `stage_b_completed` gate `reviewer` |
| QA (Stage B) | `task` simulation with `[TESTED] \| task-N.M \| PASS/FAIL/SKIPPED \| …` (test_engineer vocabulary — never `REJECTED`) | evidence `stage_b_completed` gate `test_engineer`; both gates required → `tests_run` |
| finish | `update_task_status` tool (completion refused until both Stage B gates pass) | `task_completed` → `complete`; ledger `task_status_changed` |
| restart | second `server()` boot (every boot runs `loadSnapshotForInit` → `rehydrateState`) | durable evidence/ledger/WALs rehydrated; generation rules below |
| inspect | `check_gate_status`, `get_approved_plan` | reads `.swarm/evidence/{taskId}.json`, ledger |

Workflow states (forward-only): `idle → coder_delegated → pre_check_passed →
reviewer_run → tests_run → complete`, with `rework_required` as the failure
sink. **Generation** bumps on every `accepted_mutation` (coder dispatch with
mutation) and on `repair_idle`; a Stage A/B receipt whose correlation
generation is stale is rejected (`TASK_WORKFLOW_GENERATION_MISMATCH`, the
`late_result` Stage A route) and never advances the task. Restart semantics:
plan identity is retained across boots; the task's durable generation
survives; a late result from an old generation is refused; accepted-then-dead
work classifies via the #2665 vocabulary (`stale` for a provably-dead owner —
deterministic repair; `ambiguous`/`live_wedge` for live foreign ownership).
A plan whose identity (swarm/title) was mutated after approval is refused by
`get_approved_plan` (drift/tampering), never returned as a binding.

## Fixture setup

- Driver: `tests/helpers/execute-journey-driver.ts` boots the REAL plugin
  (`OpenCodeSwarmPlugin.server()` via `bootSwarmPluginHost`) against a
  disposable git-initialized temp project, XDG-hermetic via
  `createIsolatedTestEnv()` (the #2033 prod-store tripwire requires full
  platform-root redirection — `LOCALAPPDATA`/`XDG_DATA_HOME` etc. — not just
  `XDG_CONFIG_HOME`; without it the Stage B route store unbinds settlements).
- Deterministic transport: a constructor-injected `ScriptedHostClient`
  (real SDK response shapes) records every host call; native-task child
  outputs are scripted at the hook boundary. No live model, no network.
- Tests: `tests/unit/execute-journey/j01…j07` (per-file CI on all three
  OSes). j04's restart uses `resetSwarmStatePreservingSingletons()` between
  in-process boots — a real second OS process would run the same hydration
  path; this in-process limitation is the disclosed boundary of the restart
  claim.

## Executed host/runtime cells

Executed (CI-verified): **Bun × {Windows, macOS, Linux}** via the per-file
unit shards.

Executed on demand with retained evidence: **canary script refusal and
bounded-failure paths under Node** (`node scripts/canary-execute-journey.mjs`
→ exit 3 / exit 4).

LABELED UNEXECUTED (no claim made): full journey under Node; Node on
macOS/Linux; the live-model canary leg (requires a verified live OpenCode
server; operator-initiated). These cells are recorded as
`labeledUnexecutedCells` in every journey report.

## Deterministic transport vs model-backed canary

Two report families, structurally separate (issue AC2):

- **Deterministic** (`fixture_class: 'deterministic'`,
  `transport: 'scripted-client'`): the j01–j05 fixtures. Written as
  `journey-*.json` under the temp project's `.swarm/journey/`.
- **Model-backed canary** (`fixture_class: 'model-canary'`,
  `transport: 'live-model'`): `scripts/canary-execute-journey.mjs`, gated by
  `SWARM_EXECUTE_JOURNEY_CANARY=1` plus an explicit live server URL
  (`SWARM_EXECUTE_JOURNEY_CANARY_SERVER`/`OPENCODE_SERVER_URL` — a project
  config file is NOT transport evidence). Ungated → exit 3 refusal; gated
  without a reachable server → exit 4 typed failure; the live leg drives a
  real model round-trip through the OpenCode server SDK and only then writes
  `canary-*.json`. `validateCanaryEvidence` rejects any deterministic report,
  so a mock can never masquerade as model quality.

## Evidence needed to call a run complete

A run is complete only when its `JourneyReport` passes
`validateJourneyReport`:

1. every stage carries durable evidence — a `.swarm` artifact reference OR a
   structured receipt (registered tool-call id + result id). A stage
   represented only by stdout or process exit REJECTS the report;
2. a journey that reached `finish` carries the exact approved-plan binding
   (`planId` + approved `payload_hash`, with `drift_detected === false`);
3. failure/rejection controls stay in their distinct channels (settlement
   `coder:` transitions vs `gate-failed:` stage-b rejections);
4. restart controls prove generation continuity and old-generation refusal;
5. cancellation controls settle bounded with typed terminals.

Labeled gap: the repo has **no dedicated EXECUTE-scope coder-cancel tool**;
the registered bounded-cancellation surfaces are the lane-level
`collect_lane_results` `cancel_pending` (typed `liveness` terminal) and the
session-end settle path (j03 covers both). A dedicated coder-task cancel
surface is future work outside this qualification row.
