# Execution Modes

Swarm has two orthogonal mode systems:

- **Session modes** (Turbo, Full-Auto) — toggled per-session via `/swarm turbo` and `/swarm full-auto`.
- **Project modes** (`execution_mode`) — set in config; controls hook overhead project-wide.

They compose independently. You can run `execution_mode: "strict"` with Turbo on, or `execution_mode: "balanced"` with Full-Auto on.

---

## Session Modes

### Balanced (default)

All QA gates run normally. Every task passes through reviewer + test_engineer before the architect marks it complete. This is the default when no session mode is set.

### Turbo

Skips Stage B (reviewer + test_engineer) for low-risk tasks. The task still goes through automated gates (syntax, placeholder, SAST), just not human-level review.

**Turbo does NOT skip Tier 3 files.** Security-sensitive paths always run full review, even when Turbo is on:

- `architect*.ts`, `delegation*.ts`, `guardrails*.ts`, `adversarial*.ts`, `sanitiz*.ts`
- `auth*`, `permission*`, `crypto*`, `secret*`, `security*.ts`

This list is enforced at `src/tools/update-task-status.ts:98-109`. You cannot turn it off.

**When to use:** rapid iteration on non-critical code — UI tweaks, documentation, internal refactors.

**Toggle:**

```bash
/swarm turbo on
/swarm turbo off
/swarm turbo          # toggle
```

Session-scoped. Resets when you start a new session.

### Full-Auto

Full-Auto is opencode-swarm's autonomy control plane. It reduces approval friction by deterministically allowing safe operations and routing ambiguous or high-risk operations through the read-only `critic_oversight` agent before they execute. Unlike Turbo (which bypasses Stage B for non-Tier-3 files), Full-Auto adds a *new* decision layer on top of every existing guardrail.

**First-class toggle.** Full-Auto is enabled and disabled at will from the session — no config-level enablement is required:

```text
/swarm full-auto on              # activate (supervised mode by default)
/swarm full-auto on strict       # activate with a mode override for this run
/swarm full-auto off             # disarm and return to interactive operation
/swarm full-auto status          # report the durable run state
/swarm full-auto retry-oversight # bounded infrastructure health probe while paused
/swarm full-auto resume          # resume after the exact pause condition is repaired
/swarm full-auto abort           # terminate the paused run
/swarm full-auto exit            # alias for off/disarm
/swarm full-auto                 # bare toggle
```

While active, the critic reviews escalations, phase boundaries, delegations, and architect questions on your behalf; only an `ESCALATE_TO_HUMAN` verdict (or a pause/terminate condition) hands control back to you. `off` **disarms** the run (durable status `idle`) and returns the session to normal interactive operation; paused/terminated states are reserved for system-initiated halts (denial limits, critic verdicts) and fail-closed-block non-read-only tools until you re-enable. An optional mode after `on` (or a bare mode token) overrides `full_auto.mode` for the run and is what the permission classifier enforces.

Administrators can refuse runtime activation entirely with `full_auto.locked: true`. `locked` ORs across config levels — a repo's project config cannot override a user-level lock — and activation also fails closed when a config file exists but cannot be parsed (an unreadable lock is treated as "unknown", not "unlocked"). `off` and `status` always work. Note the difference from the old gate: `enabled: false` used to make the hooks permanent no-ops, while `locked` keeps them armed — a corrupt `.swarm/full-auto-state.json` still fail-closed-blocks non-read-only tools project-wide until restored or deleted (`/swarm full-auto status` reports this as `UNREADABLE`).

The legacy `full_auto.enabled` flag is deprecated as a gate — it no longer arms or disarms anything. The v2 hooks (permission, delegation, input probe, cadence, phase approval) are gated by the durable per-session run state; the legacy reactive intercept is gated by the in-memory session flag (with a deliberate any-session fallback for messages without a session ID).

All tuning still lives in config (every field optional):

```json
{
  "full_auto": {
    "locked": false,
    "mode": "supervised",
    "fail_closed": true,
    "max_interactions_per_phase": 50,
    "deadlock_threshold": 3,
    "escalation_mode": "pause",
    "permission_policy": {
      "enabled": true,
      "trusted_roots": ["."],
      "trusted_domains": [],
      "protected_paths": [".git", "package.json"],
      "allow_defaults": true
    },
    "denials": {
      "max_consecutive": 3,
      "max_total": 20,
      "on_limit": "pause"
    },
    "oversight": {
      "on_plan_change": true,
      "on_task_completion": false,
      "on_phase_boundary": true,
      "on_high_risk_action": true,
      "on_subagent_return_warning": true,
      "every_tool_calls": 25,
      "every_architect_turns": 5,
      "every_minutes": 20
    }
  }
}
```

> **Defaults note:** `locked` defaults to `false` (runtime toggle available). `permission_policy.protected_paths` has 20 defaults including `.github/workflows`, `.swarm/`, lockfiles, `CHANGELOG.md`, and guardrail paths; the two shown above are the minimal override.

#### Modes

- `assisted` — least invasive. The deterministic policy still runs, but
  task completion does not require critic verification.
- `supervised` (default) — the deterministic policy + critic escalation for
  ambiguous/high-risk actions. Phase boundaries always require critic approval.
- `strict` — like supervised, but every task completion also requires critic
  verification.

#### Permission policy

The deterministic classifier handles obvious cases without an LLM call:

- **Allow** — read-only swarm and search tools, evidence/status reads,
  in-scope writes by coder, plan/evidence pathless tools.
- **Deny** — writes outside the project root, writes outside declared coder
  scope, direct writes to `.git`, exfiltration-like network actions,
  destructive shell, production deploys/migrations/force-push, permission
  grants, secret access, attempts to disable Full-Auto.
- **Escalate to critic** — package.json / lockfile changes, plugin/build
  config touches, guardrail/delegation/plan-ledger/evidence/tool-registry
  changes, shell commands not in the deterministic safe set, web/network
  fetches to non-trusted domains, dependency mutations, Task delegations,
  `phase_complete`, `update_task_status(completed)` (strict mode), tool
  output injection followed by a risky action, repeated denials, plan
  mutation after approval.
- **Escalate to human** — irreversible external operations, production
  infrastructure changes, or critic verdicts of `ESCALATE_TO_HUMAN`.

#### Deny-and-continue behavior

A denial is returned to the agent as a structured error so it can choose a
safer path (declare scope, switch to a read-only verification, ask for
approval). Denials accumulate against two thresholds:

- `denials.max_consecutive` (default 3) — pause when N consecutive denials
  occur without an allowed action in between.
- `denials.max_total` (default 20) — pause when the cumulative session
  denial count is reached.

`denials.on_limit` controls whether the run is paused or terminated.

#### Prompt-injection scanner

Tool output from `web_search`, `webfetch`, `fetch`, `doc_extract`, `doc_scan`,
`gitingest`, `extract_code_blocks`, `retrieve_summary`, `search`, `read`, and
`view` is inspected for instruction-override, system-role-override,
credential-request, exfiltration, guardrail-disable, and curl-pipe-shell
patterns. Detections write a `full_auto_input_warning` event and stash a
warning on the session. The next risky action (shell, network, secret-read)
escalates to the critic instead of using the deterministic policy.

#### Subagent outbound and return checks

- **Outbound** — Task delegation requires a registered subagent, declared
  scope (for coder), and triggers an advisory if the prompt mentions a
  protected path.
- **Return** — The result text is scanned for skipped tests, tool timeouts,
  scope changes, "instructions from external content", missing evidence,
  and out-of-scope file generation. Severe categories pause the run.

#### Critic escalation triggers

A critic dispatch happens for: tool actions classified as escalate, plan
mutation after approval, `phase_complete`, task completion (strict),
subagent-return warnings, periodic cadence (every N tool calls / architect
turns / minutes), and on near-limit consecutive denials.

#### Phase approval gate

When Full-Auto v2 is active, `phase_complete` requires an APPROVED
`full_auto_oversight` evidence record at
`.swarm/evidence/{phase}/full-auto-*.json`. Stale (>24h), missing, or
non-APPROVED records block. Turbo does NOT bypass this gate.

#### Fail-closed behavior

When `fail_closed: true` (default), the permission/oversight layer pauses
the run on any of: missing `opencodeClient`, critic dispatch failure,
unparseable critic response, severe subagent return warning, denial
threshold reached.

#### Recovery

Paused or terminated runs are durable in `.swarm/full-auto-state.json`. To
resume:

```bash
/swarm full-auto on    # creates a fresh running record for the session
```

Inspect the file to see `pauseReason` / `terminateReason` and the denial
history. Address the underlying cause before re-enabling.

#### Legacy v1 fields

`max_interactions_per_phase`, `deadlock_threshold`, `escalation_mode`, and
`critic_model` continue to control the reactive intercept that fires on
architect text patterns. v1 and v2 layers run together — v2 verdicts are
also mirrored from v1 dispatches when a durable run exists.

**When to use:** long-running phases you want to run unattended. Pair with
Balanced or Strict `execution_mode` for safety.

### Combining Modes

**Lean Turbo** composes with all session modes — it is a lane planning layer, not a mode toggle. It partitions tasks into parallel lanes when `turbo.lean` is configured in config, regardless of whether Turbo or Full-Auto is active.

**Turbo + Full-Auto** are independent. Both can be on simultaneously — Turbo bypasses Stage B gates for qualifying tasks, Full-Auto keeps the architect moving between tasks without prompting you.

---

## Project Modes (`execution_mode`)

Set in your project config (`.opencode/opencode-swarm.json`):

```json
{
  "execution_mode": "balanced"
}
```

Persistent. Controls hook overhead at session init.

### `strict`

Enables slop-detector and incremental-verify hooks. Maximum safety for security-sensitive projects or production deploys. Higher latency per message due to added validation passes.

### `balanced` (default)

Standard hooks. Appropriate for most projects.

### `fast`

Skips the compaction service. Use when you're hitting context pressure on short sessions and willing to trade summary fidelity for speed.

---

## Mode Summary

| Mode | Scope | Persistent | Skips | When |
|------|-------|:---:|------|------|
| Balanced (session) | Session | No | Nothing | Default |
| Turbo | Session | No | Stage B for non-Tier-3 | Rapid iteration |
| Lean Turbo | Session | Config | Parallel lanes for non-conflicting tasks | Multi-task phases |
| Full-Auto | Session | No | User confirmation between interactions | Unattended runs |
| `execution_mode: strict` | Project | Yes | Nothing; adds slop-detector + incremental-verify | Security-critical |
| `execution_mode: balanced` | Project | Yes | Nothing | Default |
| `execution_mode: fast` | Project | Yes | Compaction service | Short sessions |

## v8 Parallel-First Execution (#1674)

v8 flips opencode-swarm's published core execution contract from serial-by-default
to **safe-concurrent-by-default for provably disjoint work**, with serial as the
automatic, gate-enforced fallback.

### How it works
- **New plans default to `parallelization_enabled: true`** (applied at
  `save_plan` time; existing plans are unchanged on upgrade — see the v8 release
  fragment for the migration guard).
- **The execution gate enforces disjointness inline.** On every coder dispatch,
  the delegation gate computes a pairwise file-conflict verdict over the active
  phase's pending tasks (via the same pure helper the `plan_conflict_check` tool
  exposes). Overlapping or unknown declared scopes → `parallelModeActive === false`
  → serial, automatically. No architect discretion required.
- **Worktree isolation is the safety net.** When the gate permits parallel
  dispatch, each coder runs in its own isolated git worktree; merge-back aborts
  preserve the worktree on conflict (`#1657` durable recovery records + orphan-
  cleanup exemption).

### `plan_conflict_check` (advisory tool, #1656)
The architect can call `plan_conflict_check` *before* attempting parallel
dispatch to inspect the conflict matrix and a suggested serialization order. It
is genuinely read-only (writes nothing); the gate independently recomputes the
same verdict at dispatch time. Use it to choose disjoint task groups and
understand why the gate will (or won't) permit parallelism.

### Recovery UX (#1657)
When a lane's merge-back fails, a durable recovery record is written under
`.swarm/recovery/`. `/swarm status` surfaces a "Preserved recovery worktrees"
section, and `cleanupOrphanedBranches` exempts recovery branches (fail-safe on
read error). Records auto-clear when the lane later merges back successfully.

### Opting out
- Per-plan: `execution_profile.parallelization_enabled: false` at `save_plan`.
- Globally: `worktree.policy: disabled` (disables worktree isolation entirely).

---

## QA Gate Reference

### `council_mode` (Per-Task Council)

When enabled, replaces per-task Stage B (reviewer + test_engineer) with the full 5-member council (critic, reviewer, sme, test_engineer, explorer). Stage A still runs. Requires `council.enabled: true` in config. Evidence is written to `.swarm/evidence/{taskId}.json` under `gates.council` and validated for verdict, quorum, and timestamp.

### `phase_council` (Phase-Level Council)

When enabled, a full 5-member council reviews all work in a phase holistically at `phase_complete` time. Additive to per-task gates. Evidence is written to `.swarm/evidence/{phase}/phase-council.json` and validated for verdict, quorum, timestamp, and phase number.

### `final_council` (Project-Level Final Council)

When enabled, the final phase cannot complete until the architect dispatches the full 5-member council (`critic`, `reviewer`, `sme`, `test_engineer`, `explorer`) — NOT the General Council — with completed-project context and calls `write_final_council_evidence` with their collected `CouncilMemberVerdict` objects. Evidence is written to `.swarm/evidence/final-council.json` and validated for approved verdict, plan binding, and quorum metadata. This is the full 5-member council (not General Council mode) and does not use `convene_general_council`.
---

## Lean Turbo Lane Planning Engine

Lean Turbo (`src/turbo/lean/`) partitions phase tasks into parallel lanes based on file-scope conflicts, enabling multiple coders to work concurrently on non-conflicting tasks.

### What Lean Turbo Is

Lean Turbo is a **lane planning execution strategy** — not a mode toggle — that partitions phase tasks into parallel lanes based on file-scope conflicts, enabling multiple coders to work concurrently on non-conflicting tasks. It composes with all session modes (Turbo, Full-Auto, Balanced).

Key characteristics:
- **Lane planning layer** — Lean Turbo runs on top of existing session modes; it does not replace them
- **Parallel coder execution** — multiple coders dispatched simultaneously, each working in their own declared-scope lane
- **File-conflict partitioning** — tasks assigned to lanes based on declared scopes and file conflict analysis
- **Config-driven** — enabled via `turbo.strategy: "lean"` in config; `/swarm turbo lean on` activates it for the session
- **Stage B model** — lane tasks skip per-task Stage B (reviewer + test_engineer); quality is enforced at phase-end via phase reviewer and critic gates. Degraded and serialized tasks retain full Stage B.

### Comparison with Standard Turbo

| Aspect | Standard Turbo | Lean Turbo |
|--------|---------------|------------|
| Stage B | Skipped for non-Tier-3 files | Skipped for lane tasks; phase-end reviewer/critic as quality gate. Degraded/serialized tasks retain full Stage B |
| Coder execution | Single coder | Multiple coders in parallel lanes |
| Activation | `/swarm turbo on` (session toggle) | `turbo.strategy: "lean"` in config + `/swarm turbo lean on` |
| Scope handling | No scope analysis | Partitioned by file-conflict analysis |
| Degradation | N/A (single flow) | Degraded tasks fall back to standard serial flow |
| Full-Auto composition | Independent | Subject to Full-Auto permission policy; Full-Auto paused/terminated blocks lean runner |
| Tier 3 patterns | Respected | Respected |

### Composition with Full-Auto v2

Lean Turbo composes with Full-Auto v2 when both are active:

- **Lane dispatch** is subject to Full-Auto permission policy — coders must pass the deterministic classifier or get critic escalation before receiving work
- **Full-Auto paused/terminated** blocks the Lean Turbo runner — it will not dispatch new lanes until Full-Auto is resumed
- **Full-Auto phase approval** is required before `phase_complete` even when Lean Turbo evidence exists — the `full_auto_oversight` gate at `.swarm/evidence/{phase}/full-auto-*.json` must be APPROVED
- Both can be active simultaneously — Lean Turbo handles task parallelization while Full-Auto handles permission/escalation decisions

### Architecture

```
planLeanTurboLanes(directory, phaseNumber, plan, config, scopes?)
    ├── 1. Task extraction        → filter completed tasks
    ├── 2. Scope resolution      → declared scopes → scope files → files_touched fallback
    ├── 3. Risk classification    → global / protected / no-scope / invalid-scope / normal
    ├── 4. Topological sort      → Kahn's algorithm with fail-closed cycle handling
    └── 5. Lane assignment        → greedy conflict-free parallelization (max_parallel_coders lanes)
```

### Conflict Detection Rules

Two tasks conflict if they touch:

- **Same file** — identical paths
- **Parent/child directories** — e.g., `src/auth/` vs `src/auth/login.ts`
- **Global files** — `package.json`, lockfiles, barrel files (`src/index.ts`), build config — always degraded
- **Protected paths** — paths containing `auth`, `crypto`, `secret`, `security`, `.env`, etc. — degraded or serialized based on `degrade_on_risk`

### Risk Classification (`src/turbo/lean/risk.ts`)

| Category | Trigger | Policy |
|---|---|---|
| `global` | Touches a global file | Always degraded → `balanced` mode |
| `protected` | Touches a protected path | `degrade_on_risk` → degraded; else serialized |
| `invalid-scope` | Scope contains `..` traversal | Serialized |
| `no-scope` | `require_declared_scope: true` + no declared scope | Serialized |
| `normal` | Regular scoped files | Parallelized across lanes |

### Lane Assignment Algorithm

1. **Wave-based dependency ordering** — tasks are grouped into dependency waves; a task's dependencies must complete before it enters the queue
2. **Cross-lane dependency tracking** — if a task depends on another in a different lane, it is serialized until that dependency completes
3. **File claim tracking** — each lane tracks claimed files; a task with any claim conflict is degraded or serialized
4. **Cycle detection** — Kahn's algorithm detects dependency cycles; all tasks in a cycle are fail-closed to serialized

### Path Normalization

All paths are normalized to POSIX-style (forward slashes, no trailing slash, `.` segments collapsed) before conflict detection. Windows paths are lowercased for consistent cross-platform comparison.

### Key Types

```typescript
// src/turbo/lean/planner.ts
interface LeanTurboLanePlan {
  phase: number;
  planId: string;
  lanes: LeanTurboLane[];         // Parallel coder lanes
  degradedTasks: LeanTurboDegradedTask[]; // Tasks degraded to balanced
  serializedTasks: string[];       // Tasks forced sequential
  degradationSummary?: string;      // Human-readable when all degraded
  counters: LeanTurboCounters;
  crossLaneDependencies: Record<string, string[]>; // dep taskId → [other lane taskIds]
}

// src/turbo/lean/conflicts.ts
// DEFAULT_GLOBAL_FILES — 27 global files (package.json, lockfiles, barrels, build config)
// DEFAULT_PROTECTED_PATTERNS — 19 protected path patterns (auth, crypto, secret, .env, etc.)
// normalizePath(filePath) → POSIX path
// pathsConflict(path1, path2) → boolean (same file or parent/child)
// isGlobalFile(normalizedPath) → boolean
// isProtectedPath(normalizedPath) → boolean
// readTaskScopes(directory, taskId) → string[] | null (reads .swarm/scopes/scope-{taskId}.json)

// src/turbo/lean/worktree.ts
// provisionWorktree(laneId, branchName, baseBranch, config) → Promise<WorktreeResult>
// removeWorktree(laneId) → Promise<void>
// assertCleanWorkingTree() → void (throws if dirty)
// isCleanWorktree() → Promise<boolean>
// autoCommitDirty(message) → Promise<string> (returns commit hash)
// cleanUntrackedFiles() → Promise<void>

// src/turbo/lean/merge-back.ts
// getMergeStrategy(config) → 'merge' | 'rebase' | 'cherry-pick'
// mergeLaneBranch(laneId, strategy) → Promise<MergeSuccess | MergeFailure | MergeConflict>
// postMergeCleanup(laneId) → Promise<CleanupSuccess | CleanupFailure>
// handleMergeConflict(conflictInfo) → Promise<ConflictHandlingError | null>
// attemptMergeBackFromDirty(laneId, strategy) → Promise<DirtyMergeSuccess | DirtyMergeFailure | DirtyMergePartial>
// cleanupOrphanedBranches() → Promise<OrphanCleanupResult>
// startupOrphanRecovery() → Promise<StartupRecoveryResult>
```

### Commands

Lean Turbo is controlled via `/swarm turbo lean`:

```
/swarm turbo lean on      # enable Lean Turbo explicitly
/swarm turbo lean off     # disable Lean Turbo
/swarm turbo lean         # toggle Lean Turbo on/off
/swarm turbo status       # show detailed status including active lanes and degraded tasks
/swarm turbo on           # follows turbo.strategy config (lean when config says lean, otherwise standard)
/swarm turbo standard on  # force standard turbo (disables lean even if config says lean)
```

`/swarm turbo status` displays:
- Whether Lean Turbo is active and configured
- Number of active lanes and tasks per lane
- Degraded tasks with reasons (global file, protected path, no scope, invalid scope)
- `degradation_summary` when all tasks degraded

### Evidence and Phase Reviewer/Critic Requirements

Lane evidence is written to `.swarm/evidence/{phase}/lean-turbo/` per lane:
- Each lane writes its own evidence file (`lane-{n}.json`)
- Contains task IDs, assigned files, lane status, and completion state

Phase-level evidence is written to `.swarm/evidence/{phase}/lean-turbo-phase.json`:
- Aggregates all lane outcomes
- Contains lane completion status and cross-lane dependency resolution
- Used by phase gates to verify lane completion

**Phase reviewer and phase critic** — when configured via `turbo.lean.phase_reviewer` and `turbo.lean.phase_critic`:

- **Phase reviewer** — dispatched with combined phase diff; read-only verification that all lane tasks are complete and consistent
- **Phase critic** — dispatched with boundary review; read-only verification of lane phase boundaries and cross-lane dependencies
- Both are **required** at `phase_complete` when configured — absence blocks the phase gate
- These serve as the holistic quality gate for lane tasks (which skip per-task Stage B). Degraded and serialized tasks still get individual Stage B.

### Recovery from Paused/Blocked

Paused or terminated Lean Turbo runs are durable in `.swarm/turbo-state.json`. To resume:

```bash
/swarm turbo lean on    # creates a fresh running record for the session
```

Inspect the file to see:
- `pauseReason` / `status` — why the run is paused or terminated
- `degradedTasks` — tasks that fell back to serial flow
- Denial history if Full-Auto integration is active

**Degraded tasks** — when Lean Turbo cannot place a task in a parallel lane, it falls back to standard serial flow:
- Degradation reasons: global file conflict, protected path, unknown scope, invalid scope
- Degraded tasks do **NOT** get Lean Turbo lane bypass — they run full Stage B gates (reviewer + test_engineer)
- `degradation_summary` shown in status when all tasks degraded

**Full-Auto blocking** — Full-Auto state can block the Lean Turbo runner:
- Full-Auto paused or terminated prevents new lane dispatches
- Check `/swarm full-auto status` to diagnose
- Resume Full-Auto first with `/swarm full-auto on`, then re-enable Lean Turbo if needed

### Configuration

Lean Turbo is configured via `turbo` and `turbo.lean` in `.opencode/opencode-swarm.json`:

```json
{
  "turbo": {
    "strategy": "lean",
    "lean": {
      "max_parallel_coders": 4,
      "require_declared_scope": true,
      "conflict_policy": "serialize",
      "degrade_on_risk": true,
      "phase_reviewer": true,
      "phase_critic": true,
      "integrated_diff_required": true,
      "allow_docs_only_without_reviewer": false,
      "worktree_isolation": true
    }
  }
}
```

| Key | Default | Effect |
|---|---|---|
| `strategy` | `"standard"` | `"lean"` enables Lean Turbo lane planning; `"standard"` uses single-coder Turbo |
| `max_parallel_coders` | `4` | Maximum concurrent coder lanes (1–6) |
| `require_declared_scope` | `true` | Fail-closed on tasks without declared scope |
| `conflict_policy` | `"serialize"` | `"serialize"` → sequential for conflicting tasks; `"degrade"` → switch to balanced |
| `degrade_on_risk` | `true` | Protected-path tasks degraded to balanced (`true`) or serialized (`false`) |
| `phase_reviewer` | `true` | Dispatch phase reviewer at `phase_complete` (read-only diff verification) |
| `phase_critic` | `true` | Dispatch phase critic at `phase_complete` (read-only boundary review) |
| `integrated_diff_required` | `true` | Require integrated diff for lane evidence |
| `allow_docs_only_without_reviewer` | `false` | Allow docs-only phases when reviewer is not available |
| `worktree_isolation` | `true` | Use worktree isolation for parallel coders |

> ⚠️ **Behavior change (FR-107 / SC-121):** `worktree_isolation` now defaults to `true`. Lean Turbo phases provision per-lane worktrees by default. To retain the previous behavior, set `turbo.lean.worktree_isolation: false` explicitly.

> ⚠️ **Behavior change (#2954):** `integrated_diff_required` now defaults to `true` on every path, including projects with no `turbo` config block — a lean phase advance requires the integrated-diff evidence artifact. To retain the previous permissive behavior, set `turbo.lean.integrated_diff_required: false` explicitly in `.opencode/opencode-swarm.json`.

### Tests

111 tests covering: lane partitioning, conflict detection, parent/child path resolution, global file classification, protected path matching, cycle detection, cross-lane dependencies, scope resolution priority, Windows path normalization, and degradation summaries.

---

## Runtime Isolation (FR-201 – FR-206)

Per-lane environment isolation that prevents port collisions, cache contamination, and temp-directory conflicts when Lean Turbo lanes run concurrently.

### What is the Lane Runtime Profile

Each lane can receive a **lane runtime profile** — a set of derived environment variables written to `.swarm/lanes/{laneIndex}.env` (KEY=VAL format) inside the worktree root. Any child process spawned inside the lane can source this file to get lane-specific overrides.

The profile is produced by `computeLaneRuntimeProfile()` (`src/turbo/lean/worktree.ts` and `src/hooks/delegation-gate/worktree-isolation.ts`) from the resolved `runtime_isolation` config.

**Precedence (last write wins):**

1. **Derived PORT** — `PORT = port_base + laneIndex * port_stride` when `port_base` is explicitly set (no default)
2. **env_overrides** — explicit caller values win over derived PORT
3. **cache_redirects** — explicit cache redirect wins (last write wins)

`cache_redirects` keys must be valid env var names; values have `/lane-{laneIndex}` appended as a suffix to the configured base path using **platform-native path separators** (Windows: `\`, POSIX: `/`). The `.swarm/lanes/{n}.env` file itself always uses `KEY=VAL\n` format consumed by cross-platform tools. (e.g. `XDG_CACHE_HOME=/home/user/.cache → /home/user/.cache/lane-1` on POSIX; `TEMP=C:\Users\test\Temp\cache → C:\Users\test\Temp\cache\lane-1` on Windows)

### Default Behavior (Disabled by Default)

`runtime_isolation.enabled` defaults to `false` in both `turbo.lean` and `worktree` config blocks. When disabled, no profile is written and no environment changes are injected — **zero behavior change** for existing setups.

SC-129 / SC-130 encode this off-by-default guarantee: the integration test `cross-process-port-binding.test.ts` verifies that a disabled `runtime_isolation` produces no `PORT` injection.

### When to Enable

Enable `runtime_isolation` when:

- **Parallel lanes run port-binding servers** — each lane gets an isolated `PORT` to prevent collision (SC-122).
- **Integration test suites** need lane-scoped `TEST_DATABASE_URL`, `TMPDIR`, or `XDG_CACHE_HOME`.
- **Dev servers** run per-lane and need isolated temp directories that are auto-cleaned on teardown.
- **Cache isolation** is required — redirect `~/.cache` or similar to per-lane directories.

### Cross-Platform Parity

| Platform | Sandbox mechanism | Soft-fail behavior |
|----------|-----------------|-------------------|
| Linux | `bwrap` (bubblewrap) | If `bwrap` is unavailable, falls back to env var + port injection only |
| macOS | `sandbox-exec` | If `sandbox-exec` is unavailable, falls back to env var + port injection only |
| Windows | Windows native-runner ({mode}: restricted-token / app-container) with `powershell wrapper` fallback | If sandbox preparation fails, falls back to env var + port injection only |

All three platforms **soft-fail** — if the OS-level sandbox envelope cannot be prepared, the lane still starts with env/port isolation only. A lane is never hard-failed due to sandbox unavailability (SC-132).

The executor mechanism is detected at runtime and reported by `/swarm diagnose` under the Sandbox health-check line.

### Common Scenarios

#### Two lanes running port-binding test servers

Lane 0 gets `PORT=41000`, lane 1 gets `PORT=41010` (with `port_base=41000, port_stride=10`). Both test servers start without a collision. `port_base` must be explicitly set — there is no default; if omitted, no `PORT` is injected.

```
// turbo.lean or worktree.runtime_isolation config:
{
  "runtime_isolation": {
    "enabled": true,
    "port_base": 41000,
    "port_stride": 10
  }
}
```

#### Lane-scoped environment variables

Override `TEST_DATABASE_URL`, `TMPDIR`, or `XDG_CACHE_HOME` per lane:

```json
{
  "runtime_isolation": {
    "enabled": true,
    "env_overrides": {
      "TEST_DATABASE_URL": "postgresql://localhost:5432/test_lane_A",
      "TMPDIR": "/lane-tmp/lane-A",
      "XDG_CACHE_HOME": "/lane-cache/lane-A"
    }
  }
}
```

> **Note:** Values are copied verbatim — no `${LANE_INDEX}` template substitution is performed. To get unique values per lane, inject them via the dispatch layer before the lane is provisioned.

#### Lane-scoped cache and temp directories

Redirect cache paths to per-lane directories. The env file (`.swarm/lanes/{laneIndex}.env`) is removed at teardown, but the cache/temp directories referenced by `cache_redirects` are **not automatically deleted** unless they are inside the worktree that gets removed. External paths (e.g. `/lane-cache`) persist after teardown and must be cleaned up by the caller.

```json
{
  "runtime_isolation": {
    "enabled": true,
    "cache_redirects": {
      "XDG_CACHE_HOME": "/lane-cache",
      "TMPDIR": "/lane-tmp"
    }
  }
}
```

### Configuration

```json
{
  "turbo": {
    "strategy": "lean",
    "lean": {
      "runtime_isolation": {
        "enabled": true,
        "port_base": 41000,
        "port_stride": 10,
        "env_overrides": {},
        "cache_redirects": {}
      }
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Master switch — off by default for zero behavior change |
| `port_base` | _(none — no PORT injection)_ | Base port for lane 0; each subsequent lane gets `port_base + laneIndex * port_stride`. Must be explicitly set to enable PORT injection. |
| `port_stride` | `1` | Port increment between lanes |
| `env_overrides` | `{}` | Environment variable overrides applied to every lane |
| `cache_redirects` | `{}` | Cache path redirects for lane isolation |

The same fields are also available under `worktree.runtime_isolation` with identical semantics.

### See also

- [Configuration — `runtime_isolation`](configuration.md#turbolean-runtime_isolation--per-lane-runtime-isolation-settings)
- [`/swarm lanes` — Runtime profile state](commands.md#swarm-lanes---runtime-profile-state)

---

## Epic Mode (preview)

> **Status: opt-in, off by default.** Epic Mode needs **both** a config opt-in (`turbo.epic.mode.enabled: true`, inside a `turbo` block that declares a valid `strategy`) **and** an epic opened for the current plan with `/swarm epic start`. Without the config opt-in, `/swarm epic start`, `epic_decide_phase`, and `epic_plan_waves` refuse with reason `epic-disabled-by-config`; without an open epic the Epic tools refuse with `epic-mode-not-active`, and no Epic behaviour runs anywhere else (Rule 2 auto-commit, the Epic phase-readiness gate, the Epic banner). The four capabilities (A — co-change conflict, B — coupling report, C — activation gate, D — self-calibration) are wired through the `/swarm epic` and `/swarm coupling` commands, the `epic_decide_phase` / `epic_plan_waves` / `epic_record_divergence` / `epic_phase_review` tools, and the `EPIC_MODE_BANNER`.
>
> **Worktree-isolation interaction:** when Epic dispatches coders into isolated git worktrees, a coder whose merge-back fails leaves its work stranded outside the main tree. Epic's Rule 2 auto-commit detects this and skips the `swarm(task <id>):` completion marker so Rule 3 never treats an unmerged task as satisfied; the plan status still advances (the ledger is authoritative) and the failure is surfaced for recovery. The merge-status registry (`.swarm/worktree-merge-status.json`) is keyed by bare task id and shared with `/swarm lanes`, so Epic filters it by plan epoch: a failure recorded before the current plan's root (its first plan-ledger event) belongs to an earlier plan and no longer suppresses Rule 2; a failure with no timestamp cannot be dated and keeps suppressing Rule 2 (fail closed). `/swarm epic status` lists recorded failures as blocking, undated, or stale, with the remedy. Not every writer stamps a time (a cancelled/denied task's `task-result` record has none); once the task's work is actually in the main tree, or the record belongs to an earlier plan, clear it with `/swarm epic clear-merge-failure <taskId> --confirm` (without `--confirm` it only previews).

### What Epic Mode Is

An **epic** is one plan bound to one spec: the codebase's one-plan-per-feature convention (a `Plan` is bound to a single `.swarm/spec.md` via `specMtime`/`specHash`) means "per epic" and "per plan" are the same thing. Epic Mode asks, for that plan, *"should this work run in parallel at all, and what is making it serial?"* — by measuring coupling from declared file scopes and (optionally) git co-change history — and then runs the promoted work as concurrent **waves** of visible coder `Task` calls.

Epic Mode reuses Lean Turbo's conflict predicates, risk lists, and partition preflight by import, and never modifies `src/turbo/lean/`. It does **not** dispatch through Lean Turbo's runner: promoted waves are dispatched by the architect itself via opencode's `Task` tool, so each concurrent coder is a visible subagent you can click into.

### Mode comparison

| | Standard Turbo | Lean Turbo | Epic Mode |
|---|---|---|---|
| Enable | `/swarm turbo on` | `/swarm turbo lean on` | `turbo.epic.mode.enabled: true` + `/swarm epic start` (opens an epic for the current plan; enables neither Turbo nor Lean) |
| Parallelism | None | Lanes (serial chains) dispatched by `lean_turbo_run_phase` | Waves dispatched by the architect as one `Task` per task, all in one message |
| Decides whether to parallelize | No | No (always lane-plans) | Yes — `epic_decide_phase` promotes or demotes on `p` + three gates |
| Phase-level gate | See [Turbo](#turbo) | See [Lean Turbo](#lean-turbo-lane-planning-engine) | Gates 1–5 as usual, plus `epic_phase_readiness` (Epic keeps Turbo off — see below) |

Under Epic Mode, per-task Stage A (`pre_check_batch`) and Stage B (reviewer + test_engineer, per the task's tier) are **always** required before `update_task_status(completed)` — for wave, serialized, and degraded tasks alike. Epic keeps Turbo off where it can: `/swarm epic start` refuses while config `turbo_mode` is true, while any session in this process has Turbo on, or while a durable Lean run is running; while an epic is open, config `turbo_mode` no longer seeds Turbo into new sessions, a session restored from its snapshot comes back with Turbo off, and `/swarm turbo` refuses to turn Turbo on. Turbo switched on in a *different* OpenCode process is not detectable — do not run Turbo elsewhere on a project with an open epic.

### The seven-step flow

The architect follows this flow only when the user asks it to run a phase (`EPIC_MODE_BANNER`, injected every architect turn while an epic is open for the current plan, carries the details):

1. **`declare_scope` for every pending task of the phase, up front — at the start of every phase** — one call per task id, tight and disjoint. Declarations live **1 hour** and are voided by any plan revision (they are bound to the exact plan id and structure hash). Completing a phase's last task advances `current_phase`, which changes the structure hash — so the next phase always starts by re-declaring its tasks. To widen an existing task's scope, re-declare it with `replace_existing: true`.
2. **`epic_decide_phase(phase)`** — runs the scope preflight, rolls calibration forward, computes `p`, applies the three gates, appends the verdict to `.swarm/evidence/epic-promotions.jsonl`, and returns `decided` (promote) or `demoted`. Error reasons include `epic-disabled-by-config`, `epic-mode-not-active`, `scopes-missing` (re-declare each listed task — undeclared, expired, or declared against an older plan revision), `no-phase`, `phase-empty`, `phase-already-complete`, and `epic-state-unreadable`.
3. **Tell the user the verdict** (promote/demote, `p`, top blocking reason).
4. **`epic_plan_waves(phase)`** — partitions pending tasks into ordered waves plus `serializedTasks` and `degradedTasks`; the architect then shows the user the wave plan.
5. **Dispatch each wave** as one `Task(subagent_type="coder")` per task id, all in one assistant message; serialized and degraded tasks follow one at a time. A demoted phase runs every task this way.
6. **Per task:** Stage A (`pre_check_batch`) → Stage B (reviewer + test_engineer, per the task's tier) → `update_task_status(completed)` → `epic_record_divergence`. Epic never waives per-task QA.
7. **`epic_phase_review(phase)`**, then the retrospective, then `phase_complete`.

### Waves vs. lanes

- A **lane** (Lean Turbo) is a serial chain; lanes run concurrently inside `lean_turbo_run_phase`'s runner.
- A **wave** (Epic) is a set of tasks with mutually disjoint declared scopes whose dependencies are all satisfied by earlier waves (or, for cross-phase upstreams, by a `swarm(task <id>):` commit marker). Waves run one after another; tasks within a wave run concurrently, capped by the epic's wave width — `turbo.lean.max_parallel_coders` in a git project, **1** in a non-git project (non-git epics run serially).
- Both planners share `src/turbo/lean/partition-common.ts` for risk classification and cycle-safe topological sort, so they classify the same inputs identically; Epic supplies its own v2-resolved scopes to it explicitly (see [Declared scopes](#declared-scopes)).

**Serialized tasks** (`serializedTasks`) could not be placed in a wave: dependency cycle, `no-scope` (no live declaration — re-declare), `invalid-scope`, or concurrency-cap exhaustion. **Degraded tasks** (`degradedTasks[].reason`) run per task after the waves: `global file conflict` / `protected path` (Lean Turbo hot modules), `cross-batch upstream not committed (greenfield-smart Rule 3)`, `unresolved in-batch dependency`, or `planning leftover (no identifiable blocker)` (a planner bug).

### Declared scopes

Epic's entry points — `epic_decide_phase`, `epic_plan_waves`, `/swarm epic decide`, and `/swarm coupling` — read declared scope **only** from the authoritative v2 scope-binding store that `declare_scope` writes, pinned to the exact plan identity: a binding counts only while it is live (1 h TTL) and was declared against the current plan structure. Legacy v1 `.swarm/scopes/scope-<taskId>.json` files are ignored, so a stale v1 file can never certify a task's scope. Epic resolves these scopes itself and passes them explicitly to the shared partition planner; where no live binding exists, the plan's `files_touched` is the fallback, and a pending task with neither is reported as `scopes-missing`. `epic_record_divergence` alone uses a separate historical, calibration-only reader (the latest declaration for the task under the current plan id, regardless of expiry), because the live binding has usually expired or been voided by the time a completed task is recorded; it is never used to authorize writes or schedule work.

### Activation gates (all must pass for promotion)

1. **p-threshold.** `p ≤` the effective activation threshold (`turbo.epic.mode.activation_threshold`, default `0.3`, possibly tightened by calibration). `p` is computed over the **entire plan's task graph**, not just the phase being run.
2. **Hot-module.** No task in scope may touch a Lean Turbo global file (`package.json`, lockfiles, barrels, build config), a protected path (`auth/`, `crypto/`, `secret/`, `.env`, …), or a calibration-promoted hot module.
3. **Greenfield (predecessor evidence).** Passes when the project is not a git repository (**Rule 1**: the co-change premise is absent), or when every cross-phase upstream task the phase depends on has a current-plan `swarm(task <id>):` marker in git history (see "Markers are plan-scoped" below). A dependency id that does not exist in the plan (a "phantom dep") fails the gate closed. The legacy `commitsObserved ≥ min_commits_for_signal` floor is **not** applied; both values are still recorded in the rationale for telemetry.

Default-serial, promote-on-proof: any failing gate forces `demote`.

### Greenfield-smart rules

- **Rule 1 — no git, no ceremony.** In a non-git project the greenfield gate is bypassed and Rule 2 never commits.
- **Rule 2 — per-task commit marker.** While an epic is open for the current plan, `update_task_status(completed)` triggers a best-effort `swarm(task <id>): …` commit. Only the task's resolvable declared-scope files are staged — scope entries are matched as **literal** pathspecs (`app/[id].tsx` or `src/*.ts` name exactly that path, never a glob; a directory entry still covers everything beneath it) — and the commit is pathspec-restricted (`--only`), so anything else already in the index — your WIP, a sibling task's files — stays staged and out of the commit; `.swarm/` is never committed. A staged rename (`git mv`) whose destination is in scope carries its source-path deletion into the same commit. With **no** resolvable scope (binding missing, expired, or declared against an older plan revision): if the working tree has no non-`.swarm` change, an empty marker is written (pure verification tasks); if it is dirty (or its status cannot be read), **no marker is written** and a critical warning names the remediation — re-run `declare_scope` and re-run the completion, or commit the task's changes manually with a `swarm(task <id>):` subject and a final `Swarm-Plan: <planKey>` trailer line (the warning prints the exact trailer). The plan ledger stays authoritative; a failed commit never blocks the status update.
- **Markers are plan-scoped.** Task ids repeat across plans, so every Rule 2 marker carries a `Swarm-Plan: <planKey>` trailer, where `planKey = sha256(planIdentityHash + '|' + planEpoch).slice(0, 16)` — the plan epoch is minted per ledger root, so consecutive plans with the same title still differ. Rule 2's idempotency check ("this task already has a marker") and Rule 3's predecessor evidence honor a marker only when it belongs to the current plan: its trailer equals the current plan key, or it is a legacy marker without a trailer committed at/after the plan root (the earliest plan-ledger event). Both reads are one bounded `git log` (marker `--grep`, `--max-count`; the plan-root check runs per commit, not via `git log --since`, whose walk would stop at an older-dated commit and hide newer markers), so a previous plan's `swarm(task 1.1):` never makes the current plan's 1.1 an idempotent skip or satisfies Rule 3. When the plan identity cannot be resolved, Rule 2 writes no marker and Rule 3 fails closed. A `git log` failure keeps the old polarity: Rule 2 proceeds with the commit (a possible duplicate beats a silent skip); Rule 3 fails closed. **Caveat:** re-rooting the plan ledger — a `save_plan` that renames the plan's title or swarm, `/swarm rollback`, or a truncated-ledger recovery — mints a new plan root and plan key. Markers committed before the re-root are orphaned (Rule 3 no longer counts them, so dependants serialize until re-completed: fail closed), and a worktree merge failure recorded before the re-root is treated as stale, so Rule 2 writes the marker even though that merge never landed (fail open). Check `/swarm epic status` and `/swarm lanes` after such a re-root. Later Epic v2 commits replace the plan root with Epic-owned identity and wave timestamps.
- **Rule 3 — cross-batch dependencies must be committed.** The wave/lane planners degrade a task whose cross-batch upstream lacks a current-plan `swarm(task <id>):` marker (`cross-batch upstream not committed (greenfield-smart Rule 3)`); commit the named upstreams and re-plan.

### Phase readiness (phase reviewer + phase critic)

While an epic is open for the current plan, `phase_complete` runs the `epic_phase_readiness` gate. It replaces Lean Turbo's `lean_turbo_readiness` gate, which is marked not-applicable under Epic (do not call `lean_turbo_review` / `lean_turbo_critic`).

- **Producer:** `epic_phase_review(phase)` (architect-only). The tool itself dispatches a read-only phase reviewer and, only when it APPROVES, a read-only phase critic through the plugin's review dispatcher (300 s per-role timeout), parses each verdict from the agent's response (missing/ambiguous/failed ⇒ REJECTED), and writes `.swarm/evidence/{phase}/epic-phase-review.json`. Verdicts are never accepted as arguments. It refuses while any phase task is not completed.
- **Freshness:** the evidence binds to the plan id, the status-free plan structure hash, the phase's task ids and statuses, and the content of every phase task's `.swarm/evidence/{taskId}.json`; any change (e.g. rework after review), age over 24 h, or a future-dated timestamp makes it stale — re-run `epic_phase_review`.
- **Block codes:** `EPIC_PHASE_REVIEW_MISSING`, `EPIC_PHASE_REVIEW_INVALID`, `EPIC_PHASE_REVIEWER_NOT_APPROVED`, `EPIC_PHASE_CRITIC_MISSING`, `EPIC_PHASE_CRITIC_NOT_APPROVED`, `EPIC_PHASE_REVIEW_STALE`, `EPIC_PHASE_PLAN_UNREADABLE`; each carries recovery `epic_phase_review({ phase })`.
- **Turbo interaction:** Epic keeps Turbo off (see [Mode comparison](#mode-comparison)), so Gates 1–5 run as usual and this gate adds one cross-task integration review of the concurrently executed waves.

### Lifecycle: start, status, close

An epic is **plan-scoped**: one open epic per project, bound to the current plan's identity (swarm/title) and plan-ledger root. The authority is one row in the project SQLite coordination store (namespace `turbo.epic.lifecycle`); `.swarm/epic/epic.json` is a small **sentinel** projection of it. Every Epic hot-path check (Rule 2, the phase-readiness gate, the Epic banner, the delegation-gate guidance, attribution retention) first asks "does the sentinel exist?" — so a project that never opened an epic pays exactly one `existsSync` and nothing else (no database open, no config read, no write). With the sentinel present the probe reads the row, then the config gate, then the plan identity; it never writes and never caches.

- **`/swarm epic start [--force]`** opens an epic for the current plan. Refusals, in order: `epic-disabled-by-config`; `no-plan` / `plan-ledger-unreadable` (including a plan with no ledger or no plan epoch yet — save it with `save_plan` first, so a later save cannot re-root it out from under the epic); `epic-already-open` (the same plan — idempotent, nothing changes) / `epic-open-for-other-plan`; `turbo-active` (config `turbo_mode: true`, any session in the process with Turbo on, or a running durable Lean run — Epic enables neither Turbo nor Lean and never waives per-task QA); `dirty-baseline` (git only: uncommitted changes outside `.swarm/`); `in-flight-coders` (project-wide: tracked worktree coder dispatches, non-terminal background delegations, unsettled coder settlements, preserved/claimed recovery lanes, lanes being provisioned — uncertain stores count as in flight); `not-epic-sized` (see [Sizing](#sizing)); with the epic-branch policy also `detached-head` (HEAD detached, or a branch with no commit yet) and `epic-branch-exists` (`swarm/epic/<epicKey>` is left over from an earlier, abandoned epic of the same plan — delete it with `git branch -D`). Non-git projects may open an epic, but it runs serially (one task per wave). Git epics then switch to their epic branch (see [Epic branch and landing](#epic-branch-and-landing)); if that checkout fails (`branch-create-failed`, with git's error) the row and sentinel are rolled back and nothing is opened.
- **`/swarm epic status`** (and bare `/swarm epic`) shows the epic, its sizing at start and last decision; reports an **orphaned** epic — the plan was renamed or replaced (a new ledger root) since start, so Epic behaviour is off for the current plan — with the remedy `/swarm epic close --abandon`; repairs a sentinel that disagrees with the row (stale sentinel removed, missing sentinel restored); lists recorded worktree merge failures; and retires legacy Epic v1 per-session state once (v1 rows deleted, `.swarm/epic-state.json` archived to `.imported`; a session that was still "on" gets an advisory to run `/swarm epic start` — nothing is opened automatically).
- **`/swarm epic close [--abandon] [--land squash|merge|none]`** refuses `epic-incomplete` while any task is neither completed nor closed, and refuses an orphaned or unreadable epic, unless `--abandon`. For an epic-branch epic it then runs the landing preflight **before changing anything**: `dirty-worktree` (uncommitted changes outside `.swarm/` — landing switches branches), `epic-branch-missing` (the branch was deleted; finish with `--land none`), `original-branch-missing` (recreate it, e.g. `git branch <original> <baseCommit>`, or use `--abandon`), `detached-head` (HEAD is detached on a commit that is on neither branch, so switching would orphan it). An epic branch with no changes reports `nothing-to-land` and still closes. It then marks the row `closing`, writes a close report to `.swarm/epic/reports/<epicKey>-<start>.json` and `.swarm/epic-prior/reports/` (the newest 50 kept; `epic-prior/` survives `/swarm close`), lands the epic branch (below), records the landing outcome in the report, deletes the row, and finally removes the sentinel only if it still names this epic. An interrupted close resumes on the next `/swarm epic close`. On unreadable lifecycle state, `--abandon` deletes the rows without parsing them.
- **`/swarm close`** closes an open epic as `abandoned-by-swarm-close` before archiving, so its report is archived with `.swarm/epic/` and kept in `.swarm/epic-prior/`. It never lands: with a clean tree it switches back to the original branch, keeps the epic branch, and names it in the close output. **`/swarm reset-session`** leaves the epic alone (it is plan-scoped, not session-scoped).

All lifecycle writes run inside the coordination store's `BEGIN IMMEDIATE` transaction, which serializes concurrent starts and closes across processes: only the start that creates the row writes the sentinel.

### Epic branch and landing

`turbo.epic.commit_policy` (git projects) chooses where an epic's commits go. With **`epic-branch`** (the default), `/swarm epic start` runs `git checkout -b swarm/epic/<epicKey>` right after the lifecycle row is created and records the branch only once the checkout succeeded; the original branch and base commit are recorded too. Rule 2 completion markers then land on the epic branch, and the original branch does not move until close. Worktree merge-backs land on whatever branch is checked out in the project root — they are **not** drift-guarded yet (a later Epic v2 commit adds that), so keep the epic branch checked out. If `git checkout -b` reports an error after HEAD already switched (for example a failing `post-checkout` hook) the start proceeds; otherwise it is rolled back and a branch it created at the start commit is removed again. With **`current-branch`** commits stay on the branch that was current at start and close lands nothing (the C1a behaviour). Non-git epics have no branch.

**Branch drift.** Keep the epic branch checked out while the epic is open. If HEAD is on any other branch (or detached), `epic_decide_phase` and `epic_plan_waves` refuse with `epic-branch-mismatch` (`EPIC_BRANCH_MISMATCH`, remedy `git checkout swarm/epic/<epicKey>`), Rule 2 skips its completion marker with a critical warning rather than committing onto a foreign branch (fail closed — Rule 3 then treats the task as uncommitted), and `/swarm epic status` shows the mismatch. A git failure while checking counts as a mismatch.

**Landing modes** (`/swarm epic close --land …`):

| Mode | What happens |
|---|---|
| `squash` (default) | `git checkout <original>` then `git merge --squash --no-commit swarm/epic/<epicKey>`: the epic's whole diff is **staged, uncommitted** on the original branch. Review it (`git diff --cached`) and commit it yourself. The epic branch is kept until you have committed — delete it afterwards with `git branch -D swarm/epic/<epicKey>`. |
| `merge` | `git checkout <original>` then `git merge --no-ff --no-edit swarm/epic/<epicKey>` (a merge commit). |
| `none` | `git checkout <original>` only; the epic branch is left as is for you to merge. |

`--abandon` never lands: it switches back to the original branch when the tree is clean (otherwise it stays put and says why) and keeps the epic branch. Landing is non-interactive: git runs with closed stdin, `GIT_EDITOR=true`, `GIT_MERGE_AUTOEDIT=no`, `--no-edit`, and commit signing off for the merge commit; repository hooks (`pre-merge-commit`, `commit-msg`) still run, and a hook that rejects the merge is a landing failure.

**Notes.** Ignored and untracked files follow normal `git checkout` semantics when close switches branches (git refuses to overwrite an untracked file that the other branch tracks); keep `.swarm/` git-ignored (the plugin's `.git/info/exclude` entry does this) so runtime state never takes part in landing. After a squash landing, a later `/swarm close` may offer to discard the still-staged squash as dirty tracked changes — commit it first; if it is discarded it can be recovered from the kept epic branch (`git merge --squash swarm/epic/<epicKey>`).

**Conflict recovery.** A landing that conflicts (or fails) is rolled back — squash with `git reset --merge` (a squash writes no `MERGE_HEAD`, so `git merge --abort` cannot be used), merge with `git merge --abort` — normally leaving you on a clean original branch with the epic branch untouched; if the rollback itself or the switch back fails, the close output says where HEAD actually is and asks you to check `git status`. The close stops with the epic still `closing` (the attempt is recorded and shown by `/swarm epic status`); rerunning `/swarm epic close` resumes. To land by hand: `git merge --squash swarm/epic/<epicKey>` (or `git merge --no-ff …`), resolve, stage/commit, then finish with `/swarm epic close --land none`. Landing is idempotent: a close interrupted after the squash was staged (or after the merge) detects the already-landed state on the next run instead of refusing its own staged changes.

The Epic v1 `/swarm epic on` / `off` toggles were removed. `/swarm turbo epic …` no longer enables anything: it replies with a redirect to `/swarm epic start`, and Turbo-enabling subcommands are refused while an epic is open.

### Sizing

`/swarm epic start` refuses a plan that is not worth running as an epic (reason `not-epic-sized`, with the measured values and "run it in Balanced"). With *T* pending tasks (status not `completed`/`closed`), *coverage* the share of them with a scope (live declared scope, else `files_touched`), and *L* the serial steps of a dry run of the wave planner over every phase under the epic's wave width (waves + serialized + degraded tasks):

*S* = *T* / *L*, *S*<sub>eff</sub> = 1 / ((1 − *c*) + *c* / *S*), where *c* = `coder_fraction` (the share of a task's time parallel coders overlap; QA and architect turns stay serial).

A plan is epic-sized when *T* ≥ `min_tasks` (6), coverage ≥ `min_scope_coverage` (0.8), and *S*<sub>eff</sub> ≥ `min_effective_speedup` (1.25); otherwise the reasons are `too-few-tasks`, `insufficient-scope-coverage`, `insufficient-parallelism`. `--force` opens the epic anyway and records `forced: true` in the epic record and its report. A non-git epic (wave width 1) is never epic-sized, so it needs `--force`.

### Slash command

```
/swarm epic start [--force]   # open an epic for the current plan (see refusals above)
/swarm epic close [--abandon] [--land squash|merge|none]  # close it, land the epic branch (default squash: staged, uncommitted), write the report
/swarm epic                   # same as status — the bare form never mutates the epic
/swarm epic status            # epic, orphan/sentinel repair, last decision, merge failures
/swarm epic decide            # read-only what-if: compute the verdict without dispatching or writing evidence
/swarm epic last              # most recent decision from .swarm/evidence/epic-promotions.jsonl
/swarm epic calibration       # Capability D state: learned threshold, hot modules, recent divergent tasks
/swarm epic clear-merge-failure <taskId> [--confirm]  # clear a recorded worktree merge failure blocking Rule 2 (preview without --confirm)
```

`close`, `status`, `decide`, `last`, and `calibration` work regardless of the config gate. If the lifecycle state is unreadable, `status` says so (Epic behaviour is off, fail closed) and `/swarm epic close --abandon` repairs it.

### Configuration

The `turbo` config block is a discriminated union on `strategy`: a `turbo` block without `"strategy": "standard"` — or `"strategy": "lean"` together with a `"lean"` object — fails validation and is **dropped whole**, `turbo.epic` included. Minimal opt-in:

```json
{
  "turbo": {
    "strategy": "standard",
    "epic": {
      "mode": { "enabled": true, "activation_threshold": 0.3 },
      "cochange": { "enabled": false, "threshold": 0.6, "min_co_changes": 5 }
    }
  }
}
```

| Key | Default | Effect |
|---|---|---|
| `turbo.epic.mode.enabled` | `false` | **Master gate for Epic Mode.** Required for `/swarm epic start`, `epic_decide_phase`, `epic_plan_waves`, Rule 2, the Epic phase-readiness gate, and the Epic banner. Turning it off makes an open epic inert until it is re-enabled or closed. |
| `turbo.epic.mode.activation_threshold` | `0.3` | Plan-wide `p` ceiling for promotion. |
| `turbo.epic.mode.min_commits_for_signal` | `20` | Legacy greenfield floor — recorded in the rationale for telemetry only; no longer affects the decision. |
| `turbo.epic.cochange.enabled` | `false` | **Master gate for the co-change signal** (Capability A). Off ⇒ `p` uses declared-path conflicts only and the rationale records `cochangeSignal: 'disabled-by-config'` (also in `/swarm coupling`). |
| `turbo.epic.cochange.threshold` | `0.6` | NPMI floor (range `[-1, 1]`) for a pair to contribute a co-change conflict. |
| `turbo.epic.cochange.min_co_changes` | `5` | Minimum raw co-change count before NPMI is considered. |
| `turbo.epic.calibration.*` | see below | Capability D knobs; only consulted inside `epic_decide_phase`. |
| `turbo.epic.sizing.min_tasks` | `6` | Minimum pending tasks for `/swarm epic start` (see [Sizing](#sizing)). |
| `turbo.epic.sizing.min_scope_coverage` | `0.8` | Minimum share of pending tasks with a declared scope or `files_touched`. |
| `turbo.epic.sizing.min_effective_speedup` | `1.25` | Minimum Amdahl-adjusted speedup *S*<sub>eff</sub>. |
| `turbo.epic.sizing.coder_fraction` | `0.6` | Share of a task's time that parallel coders overlap (*c* in *S*<sub>eff</sub>). |

### Capability A — Co-change-aware Pair Conflict

`src/turbo/epic/cochange-conflict.ts` exports `epicPairConflict(scopeA, scopeB, cochangePairs, threshold)` — a pure function that combines Lean Turbo's path-based pair test (`pathsConflict` from `src/turbo/lean/conflicts.ts`) with a git co-change signal sourced from the existing `co_change_analyzer` tool (composed via its `_internals.parseGitLog` + `_internals.buildCoChangeMatrix` primitives), threshold-gated by NPMI and raw co-change count.

The combination is **conservative**: the co-change signal can only escalate a verdict from "no conflict" to "conflict", never downgrade a path-based conflict. The data source (`src/turbo/epic/cochange-source.ts`) caches per-project results keyed on `git HEAD`, with FIFO eviction at 10 directories, and falls back to "signal absent" (`[]`) on greenfield repos, non-git directories, or git errors. The signal is only queried when `turbo.epic.cochange.enabled` is true.

### Capability B — Coupling KPI + decoupling roadmap

`/swarm coupling` is a **read-only diagnostic** that computes `p` for the current plan and ranks the modules that drive the most detected conflicts, using the same conflict predicate the activation gate uses.

```
/swarm coupling                                # whole plan, markdown to stdout
/swarm coupling --phase 2                      # scope to phase 2
/swarm coupling --threshold 0.7                # what-if a stricter NPMI floor
/swarm coupling --min-co-changes 10            # what-if a stricter count floor
/swarm coupling --format json                  # machine-readable
/swarm coupling --persist                      # also write .swarm/epic/coupling-report.json
```

**Output structure.** A short header (`p = 0.NNN`, X conflicting pairs out of Y), a per-module contention table, a decoupling roadmap (top-5 modules with their share of detected coupling), and a conflicting-task-pairs table with each pair's reason (`path` / `cochange` / `both`). All figures are *estimates*.

**Config-aware.** `/swarm coupling` runs without Epic Mode being on, but it is **not** independent of `turbo.epic.cochange.enabled`: with that gate off it computes path-only conflicts and the report states the co-change signal is disabled by config. `--threshold` / `--min-co-changes` only matter when the signal is enabled.

**Persists nothing by default.** With `--persist`, writes `.swarm/epic/coupling-report.json` atomically inside the project root.

### Promotion evidence

Every `epic_decide_phase` invocation appends one JSON line to `.swarm/evidence/epic-promotions.jsonl` with the timestamp, sessionID, phase, decision, `p`, gate rationale (including `cochangeSignal`), and blocking reasons. Append-only; tolerates a partial trailing line. `/swarm epic decide` computes a verdict without writing it.

### Capability D — Outcome-based self-calibration

After each task is completed, the architect calls `epic_record_divergence(directory, taskId, sessionID)`. It compares the task's latest `declare_scope` declaration (historical, calibration-only read — see [Declared scopes](#declared-scopes)) with the files attributed to that exact task's coder writes (`getModifiedFilesForTask`), and appends one line to `.swarm/epic/divergence.jsonl`. A declared directory covers every file beneath it (segment-aware: `src/auth` covers `src/auth/login.ts`, not `src/authentication.ts`), so writes inside it are not undeclared and the directory counts as used. Tasks without a declaration record nothing (`no-scope`); with Epic disabled by config the tool is a no-op (`epic-disabled-by-config`). Records carry the plan id and are idempotent per `(planId, taskId)`: a retried call with the same declared/actual sets appends nothing (`already-recorded`), and a rework after `NEEDS_REVISION` appends a record that supersedes the earlier attempt — calibration applies only the latest record per task within each batch it consumes.

On every subsequent `epic_decide_phase` call, the calibration engine consumes new divergence records and updates two persisted knobs at `.swarm/epic/calibration.json`:

| Knob | Behaviour |
|---|---|
| `activationThresholdOverride` | Tightens (toward zero) by `tighten_step` for every divergent task, capped at `floor_threshold`. Loosens (toward the static `activation_threshold`) by `loosen_step` only after `loosen_window` consecutive clean tasks; the counter resets on any divergent task and on every loosening event. |
| `hotModuleAdditions` | Files written without being declared get added permanently. **Monotonically grows** — never auto-shrinks; removal requires editing `.swarm/epic/calibration.json` by hand. |

The static config is always the ceiling: calibration can never relax past it.

#### `turbo.epic.calibration.*` knobs

| Key | Default | Effect |
|---|---|---|
| `turbo.epic.calibration.enabled` | `true` | Master gate for the calibration loop. With this off, the static `mode.activation_threshold` is always used. Inert unless `mode.enabled` is also true. |
| `turbo.epic.calibration.floor_threshold` | `0.05` | Calibration never tightens the threshold below this. |
| `turbo.epic.calibration.tighten_step` | `0.02` | Per-divergent-task tightening step. |
| `turbo.epic.calibration.loosen_step` | `0.01` | Per-loosening-event step (added toward the static config value). |
| `turbo.epic.calibration.loosen_window` | `10` | Consecutive clean tasks required before the engine loosens by `loosen_step`. |

#### Divergence-record format

Each line of `.swarm/epic/divergence.jsonl`:

```json
{
  "timestamp": "2026-05-26T18:42:11.045Z",
  "sessionID": "sess-abc",
  "taskId": "T-1.2",
  "phaseNumber": 1,
  "declaredScope": ["src/a.ts"],
  "actualFiles": ["src/a.ts", "src/global.ts"],
  "undeclared": ["src/global.ts"],
  "unused": [],
  "divergenceRatio": 0.5,
  "isClean": false
}
```

Read-tolerant of a partial trailing line. Best-effort writer — failures log but never block task completion.

---

## FAQ

**Why is the README's "Strict" mode not a session command?**  
The README table names three safety tiers for readability. In the code, the `execution_mode` config key is the persistent setting (`strict` / `balanced` / `fast`), and `/swarm turbo` is the session-scoped override. There is no `/swarm strict` command.

**Can Turbo break a security review?**  
No. Tier 3 patterns (`auth*`, `crypto*`, `security*.ts`, etc.) always run full review regardless of Turbo. See `src/tools/update-task-status.ts:98-109` for the authoritative list.

**Does Full-Auto bypass the critic?**  
No. Full-Auto v2 *increases* critic involvement: every escalate-class action gets a dedicated read-only critic verification before it executes, and phase boundaries require an APPROVED `full_auto_oversight` evidence record before `phase_complete` will succeed. Reactive intercept verdicts are also mirrored into the v2 evidence pipeline when a durable run is active. See `src/full-auto/oversight.ts` and `src/full-auto/phase-approval.ts` for the dispatch and gate.

**How does Lean Turbo avoid file conflicts?**  
The lane planner (`src/turbo/lean/planner.ts`) uses five conflict rules: exact-file match, parent/child directory containment, global file classification (package.json, barrels, lockfiles), protected path detection (auth, crypto, .env), and cross-lane dependency tracking. Tasks that can't be placed in a parallel lane are either serialized or degraded to balanced mode based on config. See the [Lean Turbo section](#lean-turbo-lane-planning-engine) for the full algorithm.

**How do I tell what mode is active?**  
`/swarm status` shows session modes. `/swarm config` shows the resolved `execution_mode`.

---

## Signal-Triggered Architect Modes (distinct from session modes)

The session/project modes above control *how* the swarm executes a plan. Separately, certain `/swarm` commands put the architect into a one-shot **signal-triggered workflow mode** by emitting a `[MODE: X ...]` activation signal that loads a dedicated skill on demand: `deep-dive` → `DEEP_DIVE`, `pr-review` → `PR_REVIEW`, `pr-feedback` → `PR_FEEDBACK`, `design-docs` → `DESIGN_DOCS`, `council` → `COUNCIL`, `issue` → `ISSUE_INGEST`, plus the spec-workflow modes (`specify`, `brainstorm`, `clarify`). These are not session modes and do not change `execution_mode`. See [Architecture Deep Dive — Signal-Triggered Modes](architecture.md#signal-triggered-modes-on-demand-skills) and the [Commands Reference](commands.md).

## Related

- [Commands Reference](commands.md) — `/swarm turbo`, `/swarm full-auto`, `/swarm status`, `/swarm pr-review`, `/swarm pr-feedback`
- [Configuration](configuration.md) — `execution_mode`, `full_auto.*`, `turbo.lean.*`, `turbo.epic.*`
- [Architecture Deep Dive](architecture.md) — QA gates, Stage B, Tier 3, signal-triggered modes
