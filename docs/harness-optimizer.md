# Governed Harness Optimizer (`/swarm harness-opt`)

Issue #2503 — the executing HarnessOpt capstone over the declarative
`harness_evolution` surface (#1825). The capstone drives **isolated,
evaluated, approved, and reversible** optimization rounds; it never enables
autonomous execution and never mutates the running checkout.

## Architecture

`src/services/harness-optimizer/`:

- **`controller.ts`** — the governed serial round loop. `freezeHarnessOptTaskSet`
  content-freezes the task population under `{split, seed}` BEFORE any round
  (mutated re-freeze fails typed `FROZEN_CONTENT_MISMATCH`); every round salts
  the substrate seed `${seed}#roundNNNNNN` from a persisted monotonic counter
  so each round derives a fresh deterministic `runId` and the SUBSTRATE's
  `claimHeldOutTest` is what enforces single-use held-out consumption
  (`TestAlreadyConsumedError` surfaces typed — the controller never masks it).
  Stop reasons are the produced `HARNESS_OPT_STOP_REASONS` enum — every
  member has a producing code path, pinned by producer-discipline tests:
  `transient_retry_budget_exhausted`, `round_budget_exhausted`,
  `wall_clock_budget_exhausted`, `spend_budget_exhausted`, `inconclusive`,
  `completed`, `stopped_by_operator`. Integrity conditions surface as typed
  errors instead of stop results (held-out consumption → the substrate's
  `TestAlreadyConsumedError`, mutated frozen content →
  `FROZEN_CONTENT_MISMATCH`, tampered materialized input →
  `HARNESS_OPT_INPUT_TAMPERED`, duplicated stream snapshots →
  `STREAM_SNAPSHOT_DUPLICATE`, replay divergence →
  `REPLAY_DECISION_MISMATCH`).
  `evaluatePilotGraduation` applies the predeclared criteria (positive lower
  CI beyond the threshold, zero protected regressions) and retains negative
  evidence verbatim under `pilots/<recordId>/record.json`.
- **`execution.ts`** — the substrate bridge. Materializes task descriptors
  into the content-addressed input root and executes through the production
  `evaluateCandidateV1` path in the substrate's disposable worktree; the
  substrate fingerprints the active checkout before and after every
  execution, so the running checkout is never mutated.
- **`comparative.ts`** — the comparative protocol: baseline, ablation, and
  simple-agent control arms on the SAME frozen task population (identical
  `taskPopulationHash`), per-arm denominators, retained negative results,
  and the stream-snapshot guard (`STREAM_SNAPSHOT_DUPLICATE` rejects an
  improvement claimed from a duplicated or cumulative stream snapshot).
- **`oracle.ts`** — the independent oracle: scores accepted task outcomes,
  artifact validity, verification evidence, and completion quality separately
  from the optimizer and the task's own scorer. A candidate whose token count
  improves while accepted artifact quality or verification evidence falls is
  REJECTED with reasons naming each drop.
- **`lineage.ts`** — durable round lineage under
  `.swarm/evolution/harness-opt/rounds/<roundId>/record.json`: candidate
  config digest, prompt/skill selection digest, task-cost accounting
  (`tokens_input`/`tokens_cache`/`tokens_output` — missing host data is the
  literal string `unknown`, never zero), the replay lineage id, the artifact
  outcome, and the recorded decision. `replayHarnessOptLineage` re-executes
  with the RECORDED fully-salted seed and `decidedAt` without touching the
  round counter, so the substrate returns the identical immutable run; any
  decision mismatch fails typed `REPLAY_DECISION_MISMATCH`.
- **`manifest.ts`** — the frozen comparative manifest validator: rejects
  empty required fields (`MANIFEST_FIELD_EMPTY`) and improvement claims
  without a measured result (`CLAIM_UNMEASURED`).

## Guarantees

- **Disabled by default.** `/swarm harness-opt run` requires
  `harness_opt.enabled: true` AND `--confirm`; `run`/`stop` are
  `toolPolicy: 'human-only'`.
- **Isolation.** Rounds execute in disposable git worktrees; the substrate
  fingerprints the active checkout before and after every execution, so the
  running checkout is never mutated.
- **No self-modification.** Activation and rollback are NOT part of this
  surface — they stay on the human-only `/swarm approve-write` + harness
  store path with exact one-shot approval facts; `activateHarnessCandidate`
  and `rollbackHarnessVersion` additionally re-validate the recorded
  candidate's approved paths against the CURRENT allowlist (#2503) and
  refuse with `allowlist_revoked`.
- **Single-use held-out.** A `test` split consumes the held-out set exactly
  once, enforced by the substrate's claim ledger.
- **Determinism and replay.** Seeded decisions are deterministic (identical
  inputs yield identical `decisionId`); replay is identity-checked against
  the immutable substrate run.
- **Containment.** All durable state lives under `.swarm/evolution/harness-opt/`
  (registered in the retention registry as `harness-opt-store`); mutations
  serialize under a `proper-lockfile` lock.

## Commands

`/swarm harness-opt plan|run|status|stop|history` — see
[docs/commands.md](commands.md#swarm-harness-opt). `run` requires
`--tasks <project-relative-json>` (an array of `{id, instruction}` task
descriptors), executes one governed round, and reports the stop reason,
decision, and token accounting.
