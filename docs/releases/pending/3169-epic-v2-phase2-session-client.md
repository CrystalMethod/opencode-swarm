---
issue: 3169
title: "v2 session client: Epic's review-dispatch capabilities bridged on OpenCode 2"
---

## What changed

OpenCode 2 hosts now get a host client for the first time: `src/host/v2/session-client.ts`
introduces a narrow `OpencodeClient` subset (`session.create/prompt/abort/delete/get`, the
`get` added because verified teardown requires it) backed by the v2 `ctx.session` domain.
`setup(ctx)` installs it as the synthetic PluginInput's `client` — feature-detected, so a
host lacking any required session-domain member keeps `undefined` and every client-absent
path stands. The shared init core's single client write site then feeds
`swarmState.opencodeClient` and the init-path `ctx.client` consumers unchanged (#3169
Phase 2, per the tracking issue's phased plan).

- **Blocking prompt emulation**: the v1 `session.prompt` contract is reproduced as a
  deferred v2 create carrying the prompt-time options (agent, model, and the read-only
  denial map as `effect:'deny'` permission entries), one sessionID-scoped `context` hook
  (fence-aware system replacement that preserves `<swarm_system_directive` provenance
  parts, plus deletion of denied keys from `event.tools`), `prompt` → bounded `wait` →
  `context()` translated into the v1 `{data:{info,parts}}` envelope — so
  `dispatchEphemeralAgent`, `createReviewModelDispatcher`, and `readProviderMessageError`
  work unchanged. A prompt addressed to a real (non-plugin-created) session id takes a
  direct path; signal-less callers (PR wake prompts) get a 10-minute wait backstop.
- **Event-sourced provider errors**: v2 surfaces refusals only via the event stream, so
  the event pump now records `session.error`/`session.execution.failed` payloads into a
  bounded store the shim's translation reads; failures surface as the v1 `info.error`
  shape with the same category v1 produces, and a failed outcome without recorded detail
  yields a bounded `provider.unknown` error instead of a silent empty success.
- **Placement fail-closed (live finding C1)**: v2 child sessions inherit the parent's
  directory and ignore the requested one, so a parented create whose requested directory
  diverges from the parent's — or whose placement cannot be verified — fails closed with
  a typed error before anything is created, routing worktree isolation to its existing
  degradation instead of silently running a "lane" session in the project root.
- **Blast-radius dispositions**: the evaluation dispatcher now feature-detects
  `app.agents` and returns a typed error on hosts without it (the one genuinely unguarded
  consumer); the lane tools' existing in-flow guards keep their typed refusals (the shim
  deliberately omits `promptAsync`/`status`/`messages`); catalog preflight fails closed to
  null exactly as before; Epic's capability guard now passes, but the epic entry point
  remains double-gated on v2 (`human-only` toolPolicy + no v2 command dispatch — Phase 4).

## Known deltas (live-verification items recorded on #3169)

Usage/cost accounting for v2 dispatches degrades to UNKNOWN until the `context()` usage
shape is live-verified (#2910 dual-host lane). Read-only enforcement rests on two v2 host
behaviors being honored (create-time `permissions` deny entries and context-hook
`event.tools` deletions) — both are recorded live-verification items; until confirmed, the
read-only posture on v2 is enforcement-by-unverified-mechanism with the system prompt as
the second line. The deferred session-create design means placeholder ids stay
plugin-internal in Phase 2 flows (Phase 3 owns host-visible lane ids).

## Who cares

Users running the plugin on OpenCode 2 (`@opencode/cli` 2.x) get working read-only
review/evaluation dispatches (curator, skill-improver, mutation generator, pr-feedback
loop, Full-Auto oversight, Lean Turbo), event-sourced provider-error classification, and
the Phase 2 prerequisite for Epic Mode. OpenCode 1.x hosts are untouched — the shim exists
only on the v2 path, and the one new consumer guard is a feature-detect that is a no-op on
full v1 clients.
