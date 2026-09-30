# OpenCode v2 hook inventory (v1 → v2)

- **Provenance:** compiled 2026-09-30 for issue #3004 / ADR-0003 against `@opencode/plugin@2.0.20` d.ts (dist/promise/*), `@opencode/schema@2.0.20`, `sst/opencode` v2.0.20 host source, and the official migration guide (opencode.ai/v2/docs/build/plugins/migrate-v1/). Adapter implementation: `src/host/v2/`.
- **Rule:** every v1 surface the plugin registers has exactly one row with its v2 destination or an explicit `no equivalent` disposition. Rows marked **delta** document an intentional behavioral difference.

## Registration mapping

| # | v1 surface (site) | v2 destination (adapter) | Status / delta |
|---|---|---|---|
| 1 | default export `{id, server}` (`src/index.ts`) | default export `{id, server, setup}` — v2 decodes the `setup` branch (excess keys ignored) | Ported (ADR-0003) |
| 2 | `server(ctx)` PluginInput `{client, directory, …}` | `setup(ctx)` v2 Context; synthetic PluginInput `{directory: ctx.location.directory, client: undefined}` injected into the shared `runServerInit` wrapper | Ported; **delta:** v2 Context has no OpencodeClient |
| 3 | `tool` map — `buildPluginToolObject()` (`src/index.ts:3758`, `src/tools/plugin-registration.ts`) | `ctx.tool.transform(editor.add)` per tool from the SAME map (`src/host/v2/tools.ts`) | Ported; **delta:** v1 tool `title`/`attachments` have no v2 surface; result maps `string \| {output, metadata}` → `{content, metadata}`; args zod shape → `z.toJSONSchema` input |
| 4 | `agent` map + autoSelect + lane permissions (v1 `config` hook, `src/index.ts:4112-4243`) | v1 `config` hook invoked against a synthetic `opencodeConfig`; `.agent` table mapped onto `ctx.agent.transform` (`prompt`→`system`, `mode` preserved, `tools` → per-tool allow permission rules, `disable:true` → editor.remove) (`src/host/v2/agents-commands.ts`) | Ported; **delta:** permission-rule mapping is best-effort pending the v2 permission-semantics port; the v1 hook's external-directory lane-permission scoping (applyLanePermissions) is dropped on v2 - #2910 follow-up |
| 5 | `config` hook command table (~90 TUI shortcuts as `{template, description}`) | `ctx.command.transform` — one `CommandDefinition` per v1 entry; `execute` submits the expanded template via `ctx.session.prompt` (`$ARGUMENTS` → invocation prompt text) | Ported; **delta:** TUI-side placeholder expansion replaced by direct substitution |
| 6 | `experimental.chat.messages.transform` (~20-step chain, `src/index.ts:4772-4836`) | `ctx.session.hook("context")` — chain runs against a translated view; materialized `swarm-guidance:*` carriers re-homed into `event.system` (`src/host/v2/guidance.ts`) | Ported; **delta:** user→system transport change (v2 renders system natively; #2526 workaround is v1-only); fence preserved; one destination per guidance unit |
| 7 | `experimental.chat.system.transform` (`src/index.ts:4845-4893`) | `ctx.session.hook("context")` — same hook; system-chain strings appended as `event.system` text parts | Ported |
| 8 | `experimental.text.complete` (`prWorkflowResponseGate.textComplete`, `src/index.ts:4842`) | **no equivalent** (official migration table) | **Delta:** PR-workflow response gate inert on v2; one bounded operational log at setup; re-homing design is the follow-up tracked on #2910 |
| 9 | `experimental.session.compacting` (`src/index.ts:4907-4929`) | `ctx.session.hook("compaction")` — translated session/model identity (`src/host/v2/hooks.ts`) | Ported; **delta:** the v1 customizer's directive output has no v2 mapping yet (turn-generation advance still runs) |
| 10 | `command.execute.before` (`src/index.ts:4933` — commandHandler interception) | **deferred.** Consumer analysis: on v1 the handler intercepts `/swarm`-family commands the TUI expands from templates; on v2 our commands register with their own `execute`, so interception of self-registered commands is structurally unnecessary. Foreign-command guarding was not exercised by any current feature gate | Deferred with disclosure (the release fragment's known-deltas paragraph names it); re-evaluate if a foreign-command guard becomes load-bearing |
| 11 | `tool.execute.before` (fail-closed guard chain, `src/index.ts:4937+`) | `ctx.tool.hook("execute.before")` — payload translation (`input`↔`args`, `id`↔`callID`, in-place `event.input` write-back) (`src/host/v2/hooks.ts`) | Ported; **delta:** denial-by-throw propagates as the v2 hook error (fail-closed preserved); per-guard v2 behavioral verification is the #2910 follow-up |
| 12 | `tool.execute.after` (~700-line toolAfter, `src/index.ts:5435-6102`) | `ctx.tool.hook("execute.after")` — completed/error result translated to `{title, output, metadata}` | Ported; **delta:** v2 result content-array joined to the v1 string `output` |
| 13 | `chat.message` (model-fallback preflight, delegation, cache-cohort, `src/index.ts:6106-6320`) | `ctx.session.hook("prompt")` — translated envelope; rewritten prompt text flows back to `event.prompt.text` | Ported; **delta:** the #2989 chat-boundary model override writes `output.message.model`, which the v2 SessionPrompt has no field for (v1-only until an equivalent v2 surface is confirmed) |
| 14 | `event` observer (`src/index.ts:3771-4109` — message.updated, message.part.updated, session idle) | `ctx.event.subscribe()` detached pump; event-name map in `src/host/v2/events.ts` (session.idle/status.updated→idle; text.delta/tool.called→part.updated; text.ended/tool.success|failed→updated; execution.failed→idle-error); unmapped types counted, never assumed | Ported; **delta:** v2 event names/shapes differ; map table lives in one module |
| 15 | `dispose` (`src/index.ts:3704-3752`) | Cleanup returned from `setup` — stops the pump, disposes every Registration, runs the v1 dispose body | Ported |
| 16 | `automation:` non-standard key (`src/index.ts:6324`) | none (never a host contract; v1 leftover) | Out of scope (v1-only) |
| 17 | `ctx.client` OpencodeClient consumers | **no v2 equivalent** — see per-consumer table below | Deltas per consumer |
| 18 | plugin config (`.opencode/opencode-swarm.json` via `loadPluginConfigWithMeta`) | unchanged — file-based config loaded via `ctx.location.directory`; `ctx.options` not consumed | Ported (single source across hosts) |
| 19 | `ctx.storage` | not used — `.swarm/` containment remains authoritative (invariant 4) | Deliberate (ADR-0003) |

## ToolContext synthesis (v2 → v1)

The v2 tool context (`{sessionID, agent, messageID, id, signal, progress}`) is bridged to the full v1 `ToolContext`: `directory`/`worktree` = project root captured at setup (invariant 4 — never `process.cwd()`), `abort` ← `signal`, `metadata({title?, metadata?})` → `progress` (argument shape mapped), `ask` → v2 permission domain when reply-capable, else fail-closed. Regression test: `tests/unit/host/v2/dual-shape-parity.test.ts` (third test - directory injection via the `src/host/v2/tools` `_internals` seam).

## Part-kind mapping (messages chain)

Text parts map 1:1. Non-text v2 content kinds (`media`, `tool-call`, `tool-result`, `reasoning`, `step-start`, `compaction`, `effort`) are preserved untouched on their message — the v1 chain's steps only read and write `type === 'text'` parts (verified against the composed steps' part-type reads). Unmappable kinds would be counted in a bounded debug log and get a row here; currently none.

## Per-consumer OpencodeClient dispositions (row 17)

| Consumer | Guard proof | v2 behavior |
|---|---|---|
| model preflight (`src/services/model-preflight.ts:337-339,501`) | `client?:` optional param; null-guarded | Client-absent path |
| PR-workflow response gate (`src/hooks/pr-workflow-response-gate.ts:625-712`) | `client?:` + `options.client?.session` | Client-absent path (gate additionally inert — row 8) |
| parent-session lookup for Task routing (`src/index.ts:2034-2042`) | client-absent branch | Client-absent path |
| evaluation/review model dispatchers (`src/review/contracts.ts:39-45`, `src/evaluation/model-dispatcher.ts:158`) | typed non-optional; **not invoked on v2** at the adapter seam | Fail-closed: dispatch surfaces are only reached through plugin-owned dispatch identities, none of which the v2 path constructs without a client |
| pr-feedback-loop runtime (`src/index.ts:2955`) | registration receives client; not invoked when client undefined | Fail-closed with bounded log |
| pr-event delivery (`src/index.ts:2997`) | as above | Fail-closed with bounded log |

Defensive test: `tests/unit/host/v2/dual-shape-parity.test.ts` (fourth test) asserts the full registration set and a resolvable cleanup on a client-less Context.
