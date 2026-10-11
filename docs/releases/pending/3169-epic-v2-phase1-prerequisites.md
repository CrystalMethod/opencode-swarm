# Epic on OpenCode 2 — Phase 1 prerequisites: subagent→task identity translation, 2.0.26 vendored types, epic toolPolicy

## What

Delivers the Phase 1 (prerequisites) slice of #3169 — the groundwork the tracking
issue defines before a v2 session client can exist — plus #3165 §D (was #3156).

- **v2 subagent→task identity translation** (`src/host/v2/hooks.ts`): OpenCode 2
  renamed the native delegation tool (`task`/`subagent_type`/`task_id` →
  `subagent`/`agent`/`sessionID`, live-verified on @opencode/cli 2.0.26). The v2
  adapter now translates at the tool-hook boundary — tool name to the bare v1
  `task`, args to the v1 names, and chain mutations written back IN PLACE onto
  the retained event input (`task_id`→`sessionID`). The delegation gate's Task
  branch, the ack collectors, and residue recognition now engage on v2 instead
  of silently no-oping. The v2 result wrapper
  `<subagent sessionID="…" state="…" …>…</subagent>` is re-rendered as the v1
  `<task id="…" state="…"><task_result>…</task_result></task>` envelope so the
  `parseTaskEnvelope`-based consumers — receipts and terminal-state handling —
  keep working for completed foreground dispatches; residue recognition
  engages through the translated tool identity itself. Running-dispatch
  correlation (`extractDispatchIds` keys on `state="running"`)
  stays inert on v2 in Phase 1: the host never emits a running wrapper here.
  The parse is
  opening-tag-tolerant (matching `parseTaskEnvelope`'s discipline), and
  wrapper-shaped text that fails to parse is passed through with a debug-gated
  log note instead of a silent `completed` classification. Cancellations
  surface as the distinct `cancelled` state (v1 parity — they never count
  toward the dispatch spawn-failure circuit). Error results keep the
  error-message text (no re-render), so a stale running wrapper inside a
  failed dispatch can never be correlated as live. **Not covered in Phase 1:**
  native v2 background dispatches — the v2 host emits no running wrapper on
  the dispatch result and delivers completions through the event pump (not yet
  translated), so background-dispatch correlation and binding retention are
  deferred to Phase 2 along with the pump work; v2 dispatches here are
  foreground-only. On v2 this recognition also ACTIVATES the gate's
  enforcement for recognized dispatches (scope policy,
  `TASK_SESSION_RESUME_MISMATCH`, isolation refusals) — intended fail-closed
  behavior that previously no-oped.
- **Vendored v2 types bumped to @opencode/plugin@2.0.26**
  (`src/host/v2/types.ts`): the `SessionDomain` method surface
  (create/get/remove/switchAgent/switchModel/prompt/generate/command/compact/
  synthetic/interrupt/update/move/wait/context) and a `WorktreeDomain` are now
  modeled so the Phase 2 session client can be written against the real
  surface. The positional `prompt` mis-model is corrected to the published
  object-input form (object-input since at least 2.0.20), which also fixes the
  v2 command bridge call in `agents-commands.ts` — a latent wrong-shape call.
- **`/swarm epic` is now schema-visible as human-only**: a model-relayed
  `swarm_command({command:"epic"})` call used to die in Zod validation on
  either host — the `SWARM_COMMAND_TOOL_COMMANDS` enum is host-independent —
  because `epic` carried `toolPolicy: 'none'`. It now appears in the
  `SWARM_COMMAND_TOOL_COMMANDS` enum and returns the ask-the-user refusal
  (this matters most where `/swarm` slash routing is unavailable, e.g.
  OpenCode 2 headless).
  Consequence on v1 agent/automation paths (human slash usage is unchanged):
  agent Bash `opencode-swarm run epic …` is blocked by the human-only guardrail,
  apply_patch payloads invoking `run epic` are blocked, and the non-TTY CLI
  requires `SWARM_ALLOW_HUMAN_ONLY_CLI=1` — matching the policy's intent that a
  human opens an epic.

## Why

Issue #3169 Phase 1 "Done when": the delegation gate's Task handling has a v2
test, and `tsc` sees the v2 session/worktree surface. Epic itself is unchanged
in this phase; the `host-unsupported` refusal described above was lifted when
the Phase 2 session client landed (#3169 Phase 2: the v2 capability guard now
passes, with the epic entry point still double-gated until Phase 4).

## Notes

Phase 2+ items remain open on #3169: the v2 session client shim, provider error
sourcing (no error text in `context()`; event-sourced), event-pump synthetic
completion parts carrying the v2 wrapper, background-dispatch correlation and
binding retention for native v2 background dispatches, child-session lane
placement, and v2 `/swarm` slash routing.
