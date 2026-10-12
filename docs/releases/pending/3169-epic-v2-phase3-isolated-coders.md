---
issue: 3169
title: "Epic on OpenCode 2, Phase 3 — worktree-isolated coders (eager parentless lane sessions)"
---

## What

OpenCode 2 hosts can now run worktree-isolated coder dispatches through the session-client
shim: a `client.session.create` whose requested directory is CONFIRMED to diverge from the
parent session's directory — always true for a worktree lane, whose directory is the lane
worktree — now takes an **eager parentless lane create** instead of the Phase 2 fail-closed
refusal. The shim immediately creates a REAL host session in the requested directory
(Phase 0 live finding: a parentless create honors `location.directory`; a parented child
would inherit the parent's directory and ignore it), verifies the placement (create echo,
`get` fallback; mismatch or unverifiable → the created session is removed and a typed error
returns), and returns the REAL session id. The delegation gate's `task_id` rewrite therefore
points the native v2 `subagent` tool at a resolvable session (via the Phase 1
`task_id`↔`sessionID` translation), Epic coder dispatches no longer degrade to
`EPIC_ISOLATION_DEGRADED` for want of a lane session, and the worktree-isolation and Epic
code paths themselves are untouched (the tracking issue's Decision 2: a client subset, not
v2 branches in consumers).

Because the host-side parent link cannot survive parentless placement, the shim REMEMBERS
the requested `parentID` and overlays it onto `get` results for eager sessions, keeping the
PR-workflow controller resolution (`pr-workflow-session-resolver`'s first-hop fallback and
the Task-route parent lookup) v1-faithful for lane children — without it, the PR gate would
fail open during a coder's run.

Client prompts addressed to an eager session apply the full treatment — `switchAgent` +
`switchModel`, a sessionID-scoped `context` hook (fence-aware system replacement preserving
`<swarm_system_directive` parts, denied-tool deletion from `event.tools`), an epoch-scoped
error clear before the prompt (the eager id is stable across retry chains), then
`prompt` → bounded `wait` → `context()` translated into the v1 `{data:{info,parts}}`
envelope. Prompt routing keys on the registry's `eager` flag: deferred/already-prompted
placeholders keep the #3186 PRR-002 retire-and-recreate semantics, and foreign real ids keep
the direct path. `delete` prunes eager records once the removal resolves.

## Why

Issue #3169 Phase 3 (tracking issue): Epic waves on OpenCode 2 could not run coders in
isolation — every lane create diverged from the parent's project root and hit the Phase 2
fail-closed guard, so Epic refused coders (`EPIC_ISOLATION_DEGRADED`) and standard parallel
coders silently serialized. Phase 0's live findings established the safe mapping (parentless
create honors placement; the `subagent` tool resumes plugin-created sessions by id); this
phase implements it inside the shim.

## Known deltas / disclosures

- v2 lane sessions have no HOST-side parent link (parentless by design); the plugin-side
  remembered-parentID `get` overlay carries the controller-resolution contract, and the
  event-fed observed-parents map still misses parentless creates (the get hop serves them —
  LVD-4 live-verification item).
- Every client-prompted eager session (lean turbo lanes, blocking `dispatch_lanes`, and
  factory creates whose caller is itself a lane session) rests on ONE of Phase 2's two
  read-only enforcement layers — the context-hook `event.tools` deletion; the
  `switchAgent`/`switchModel` calls are routing, not enforcement — because create-time deny
  permissions are prompt-time knowledge and cannot ride an eager create. Two further
  reductions of that same layer are disclosed: registry-cap eviction of a live eager record
  takes the hook-less direct path (zero layers), and whether the host FIRES the context hook
  for plugin-created sessions is itself an open live-verification item. For every one of these
  consumers the v2 status quo was a typed refusal, so this is a capability increase with a
  disclosed enforcement delta.
- The shared session registry (placeholders + eager records) is bounded at 64 with FIFO
  eviction; placeholder residue is intentionally not pruned, so a LIVE eager record can be
  evicted after 64 later insertions of any kind — its next prompt then takes the direct path
  (agent-switch only) and the parentID overlay stops applying (PR-gate resolution falls back
  to the resolver's own parents-map cache). Both degradations (and the cap's lower bound) are pinned in
  `tests/unit/host/v2/session-client-lane-registry-3169.test.ts`.
- The divergence discriminator is DIVERGENCE-ONLY, with no lane-registry check: a factory
  caller whose parent session lives in a lane (e.g. a lane coder invoking the knowledge
  curator delegate) also takes this arm and lands a parentless session in the project root,
  losing the child-of-parent TUI nesting those factories rely on. The session is ephemeral
  and caller-deleted, so the effect is transient.
- Live-verification requests for the acd17sk A/B (same pattern as Phase 2): LVD-1 the
  `subagent` tool resumes a PARENTLESS plugin-created session and the host ERRORS (does not
  silently fork) on an unresolvable `sessionID`; LVD-2 `create` echoes `location.directory`
  through the shim; LVD-3 `get(parent).location` still resolves (carried from Phase 2);
  LVD-4 the parentID overlay keeps the resolver's get-hop correct on a live host. A refusal
  surfaces as a dispatch-time subagent error with cleanup via the existing
  dispatch/orphan-recovery machinery — no silent un-isolated run.
- The epic ENTRY POINT stays double-gated on v2 (`human-only` toolPolicy + no v2 command
  dispatch); enabling, docs, and the dual-host CI lane are Phase 4.

## Migration

No user action. v1 hosts are untouched.

## Behavior changes

- **OpenCode 2 only:** `client.session.create` for a parented session whose requested
  directory DIVERGES from the parent's now performs a real, placement-verified, PARENTLESS
  host create instead of returning a typed refusal. Callers that relied on the refusal to
  detect an unavailable lane now observe a real session id; a placement failure still
  surfaces as the same typed error and `STANDARD_WORKTREE_SESSION_CREATE_FAILED`
  degradation, and a host that REJECTS the create now resolves to that same typed envelope
  rather than throwing.
- Placement compensation is time-bounded (10s per removal); a removal that fails or times
  out is reported in the typed error (with the session id) instead of being swallowed, and
  an eager record is pruned on delete only when its removal is confirmed.
- An already-aborted caller no longer completes a placement create: the created session is
  removed and the create returns a typed "aborted" error.

## Tests

- `tests/unit/host/v2/session-client-lane-3169.test.ts` (9 tests) — placement fail-closed
  arms incl. a rejecting `get`, the silent-create `get` fallback, an id-less create, the
  aborted-create compensation, the full-treatment prompt (fence-aware hook + denied-tool
  deletion + disposal), the stale-error epoch pin, the parentID overlay, and the
  delete-prune (via post-delete direct-path routing).
- `tests/unit/host/v2/session-client-lane-registry-3169.test.ts` (3 tests) — the registry
  cap's lower bound (63 records survive), interleaved eviction (both degradations), and
  eager-only eviction (oldest loses treatment, newest keeps it).
- `tests/unit/host/v2/session-client-lane-failures-3169.test.ts` (5 tests) — the FAILURE
  legs, each discriminating its fix from a revert: a rejecting create resolves to the typed
  envelope; a failed placement cleanup surfaces the session id; a long host-reported path is
  truncated; a failed delete keeps the record; a failed abort-compensation says so.
- `tests/unit/host/v2/session-client-lane-gate-3169.test.ts` (2 tests) — the REAL
  `precreateStandardWorktreeSession` through the shim: `task_id` rewritten to the real
  lane id with the `(worktree lane)` title and no `EPIC_ISOLATION_DEGRADED` under
  `isolationRequired`; PLUS the failure path — a placement mismatch throws
  `STANDARD_WORKTREE_SESSION_CREATE_FAILED`, removes the mis-placed session and publishes no
  task_id.

The one deliberately-updated base pin is `session-client-3169.test.ts` "AC3 divergent parent
directory" — its subject was exactly the removed refusal.

## Deferred to Phase 4 (explicit, owner #3169)

- **Retry-context reuse (review PRR-012):** an eager retry keeps the failed attempt's
  conversation (the v1 envelope stays correct — the translation slices from the last user
  entry — but `idleOutcome` scans all entries, so an attempt-2 turn that emits no idle
  marker can inherit attempt-1's `failed`). Isolating retries would need per-id epochs or a
  fresh session per attempt, which conflicts with the stable host-visible id the
  `subagent` tool resumes; queued with the per-id serialization follow-up.
- **Create-time permissions for factory-from-lane creates (review PRR-018):** the eager arm
  cannot carry deny permissions (they are prompt-time knowledge on v2), so a factory caller
  running from a lane session has only the context-hook deletion. A lane-registry lookup on
  the create path (the discriminator is currently divergence-only) belongs with the Phase 4
  registry work.
