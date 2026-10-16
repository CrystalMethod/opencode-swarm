---
issue: 2960
---

# Task-dispatch model failover works for underscore-named agents (issue #2960)

## What

Fixed the Task-dispatch model-fallback chain resolver so an installer-seeded,
underscore-named agent (e.g. `test_engineer`, `critic_oversight`,
`curator_phase`, `skill_improver`, `spec_writer`) resolves its configured
`fallback_models` in the default swarm.

The resolver derived the swarm id with a naive first-underscore split, so
`test_engineer` produced swarm id `test` instead of the default swarm — the
fallback chain collapsed to empty, and ONE retryable provider failure (HTTP
429/503-class) advanced the route to `exhausted`. The next `chat.message` for
that child session then threw `MODEL_FALLBACK_EXHAUSTED`, killing the whole
in-flight dispatch on a single provider blip instead of failing over.

The swarm id is now derived by length delta from the canonical role (the same
pattern the curator/skill-improver/turbo failover factories already use), so:

- All 14 installer-seeded underscore agent names resolve their seeded
  `fallback_models` chain in the default swarm; one retryable failure now
  advances to the seeded fallback model instead of exhausting the route.
- The designed terminal state is unchanged: exhausting the full
  primary+fallbacks chain still throws `MODEL_FALLBACK_EXHAUSTED`.
- Prefixed multi-swarm names (`local_test_engineer`) and legacy unprefixed
  non-underscore names (`coder`) resolve exactly as before. As a side effect
  of the corrected derivation, prefixed names whose swarm id itself contains
  an underscore — e.g. a swarm named `mega_local` whose agents are addressed
  as `mega_local_coder` — now resolve where the naive split previously
  missed.
- Documented behavior change (fail-closed direction): an UNPREFIXED canonical
  name whose first token collides with a real swarm id (e.g. `test_engineer`
  with a swarm named `test`) now resolves via the default swarm instead of
  accidentally hitting that swarm's entry; use the prefixed name
  (`test_test_engineer`) to address it.

## Why

Workstream J slot J13 (frontier-audit finding t1-src-agents-2/S1, dual-review
UPHELD HIGH): fresh installs seed `DEFAULT_AGENT_CONFIGS` — 14 underscore
agent names with non-empty `fallback_models` — so the broken path needed no
manual configuration to be live.
