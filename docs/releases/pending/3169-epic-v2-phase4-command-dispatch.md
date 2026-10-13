---
issue: 3169
title: "Epic on OpenCode 2, Phase 4 — native /swarm command dispatch (entry point enabled) + docs"
---

## What

A human-typed `/swarm <command>` on OpenCode 2 now dispatches natively instead of being
re-submitted as raw prompt text. The v2 command bridge (`src/host/v2/agents-commands.ts`)
previously expanded the v1 TUI template and submitted it via `ctx.session.prompt`, leaving the
model to interpret the text — for `/swarm epic start` its only actor (`swarm_command`)
correctly refused the human-only command, so the loop dead-ended at the very command the
refusal pointed back to. Since #3169 Phases 1–3 shipped the session client, the subagent
identity mapping, and lane placement, that bridge was the LAST gate keeping Epic unstartable
on OpenCode 2.

The `execute` now invokes the shared v1 command handler (`command.execute.before` on the hooks
object — the same `safeHook`-wrapped handler a v1 host runs for a human-typed command), which
brings the full v1 semantics to every v2 swarm command: registry resolution, help/not-found
handling, the `classifySwarmCommandChatFallbackUse` policy refusals, tool-routing instructions
for allowlisted commands, real handler execution, and the canonical output envelope. The
handler-produced prompt is submitted through the v2 session prompt surface.

- Fallback arms, all v1-faithful: an absent hook, an empty parts result, or a swallowed
  handler error submits the expanded template exactly as the old bridge did; a host without
  the session prompt surface is a side-effect-free no-op (the registry handler never runs).
- A dispatch timeout (300 s budget) submits a distinct bounded notice — never the raw
  template, so the model is never prompted to re-attempt a command that may still be
  completing in the background (`startEpic` re-entry is serialized by the lifecycle
  `BEGIN IMMEDIATE` transaction and idempotent).
- Human-only semantics are unchanged and structural: `epic` stays `human-only`, the
  `swarm_command` tool, chat-fallback, and Bash guardrail refusals are untouched, and the
  model has no tool that reaches a host command's `execute` — only the user's keystroke
  starts an epic, on both hosts.

`tests/unit/epic/start-host-unsupported.test.ts` gains the v2 case (the real
`createV2SessionClient` over a v2-shaped ctx → `startEpic` starts); the client-less refusal
pins are unchanged. Docs now tell one story (Epic runs on OpenCode 1.x and OpenCode 2 with
the 7.x plugin): `docs/modes.md` host note rewritten (removing the self-contradicting
double-gate clause), `README.md`, the epic registry details (regenerated into
`docs/commands.md`), `src/epic/start.ts`'s refusal message and its doc comment,
`src/epic/README.md` (which also gains the `host-unsupported` entry missing from its Start
refusal chain), and `docs/host/v2-hook-inventory.md` rows 5/10/48.

## Why

Without a dispatch path there was no way to start an epic on OpenCode 2 at all — Phases 1–3
had made every downstream capability work, but the entry point could only be typed, never
executed. Reusing the already-constructed v1 handler (rather than a v2 re-implementation)
means command semantics and policy cannot drift between hosts, and the human-only gate rests
on code path provenance instead of prompt-text markers a model could replay.

## Known limitations

- Live-host verification on `@opencode/cli` 2.0.26 is still requested (same A/B as Phases
  1–3): (a) the TUI command `prompt.text` carries arguments only (the `$ARGUMENTS`
  convention both the dispatch and the fallback share); (b) no model-reachable surface
  invokes a `CommandDefinition.execute` (the vendored `SessionDomain.command` is
  deliberately omitted from the session-client shim's subset) — the human-only property
  rests on this host contract, and the plugin itself sends model-controlled text through
  the session prompt surface, so this leg is load-bearing; (c) a full epic journey
  (start → waves → phase review → close) on v2; (d) whether the host also submits the
  user's original typed line after `execute` resolves is not yet live-verified (the
  dispatched text and the typed line are byte-identical for the default templates, so a
  duplication would be invisible in the Phase-1 A/B).
- The fixed 300 s dispatch budget is not cancellation: a handler that legitimately runs
  longer (commands that make sequential model dispatches — `review`, `harness-opt` — can
  need more than 2×120 s) keeps running past the notice, its eventual output is not
  delivered, and re-running is the remedy. Handlers carry their own confirmation gates
  and `startEpic` re-entry is serialized and idempotent.
- The dual-host CI lane that would run the Epic smoke on OpenCode 2 is owned by #2910.
- Phase 3's disclosed registry degradation stands (a live eager lane record can be
  FIFO-evicted after 64 later insertions).
