# Qualify the complete normal EXECUTE journey through actual supported hosts

Issue: #2666

## Summary

The normal EXECUTE journey (configure → discover → specify → approve →
EXECUTE → pre-check → reviewer → QA → finish, plus restart and inspect
controls) had per-stage unit coverage that bypassed the registered host
surfaces, so nothing proved the stages compose through the real plugin tool
map, the merged hook chain, and the durable receipts. This ships the
qualification fixture family:

- `tests/helpers/execute-journey-driver.ts` — boots the real
  `OpenCodeSwarmPlugin.server()` against a disposable git project with a
  constructor-injected scripted host client (real SDK response shapes; no
  live model, no network), drives every stage through REGISTERED surfaces
  only, records a structured `JourneyReport`, and exports
  `validateJourneyReport` (rejects any stage evidenced only by stdout or
  process exit) and `validateCanaryEvidence` (rejects deterministic reports
  as canary evidence).
- `tests/unit/execute-journey/j01…j07` — the journey matrix: happy path
  with a durable receipt at every gate and exact approved-plan binding
  (j01); provider-failure vs reviewer/QA-rejection distinctness (j02);
  bounded cancellation through observation-only `collect_lane_results`
  `cancel_pending` guidance followed by the confirmed `cancel_lane_batch`
  surface (issue #2971), plus the session-end settle path, with the absent
  EXECUTE-scope cancel tool documented as a labeled gap (j03);
  restart-after-interruption with
  generation continuity, old-generation late-result refusal, accepted-then-
  dead classification, and post-approval plan-identity refusal (j04);
  deterministic-transport and no-stdout-only guards (j05); model-canary
  separation (j06); report/docs contract (j07).
- `scripts/canary-execute-journey.mjs` — the separately-gated model-backed
  canary (`SWARM_EXECUTE_JOURNEY_CANARY`): ungated → exit 3 refusal; gated
  without a verified live server → exit 4 typed failure (a project config
  is not transport evidence); the live leg drives a real model round-trip
  through the OpenCode server SDK and writes a structurally separate
  `canary-*.json`. Runs under bun and node for the refusal/unavailable
  Node-cell evidence.
- `docs/testing/execute-journey.md` — the journey state machine, fixture
  setup, the executed/labeled-unexecuted host-runtime cells, the evidence
  needed to call a run complete, and the PR-review breadth boundary
  (#2585/#2586).

## Validation

Bun × Windows verified locally: j01 (1/1), j02 (4/4), j03 (2/2), j04 (1/1),
j05 (9/9), j06 (5/5), j07 (10/10 — report/docs/fragment contract); Bun ×
macOS/Linux runs in the same per-file unit CI matrix on every push and
merge-group run. Canary refusal verified under bun AND node (exit 3). No
production code changed — the fixture consumes existing registered surfaces
only, and the baseline registered-host suites stay green.
