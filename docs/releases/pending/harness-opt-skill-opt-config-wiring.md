---
issue: 2949
---

# harness_opt / skill_opt now reach their registered handlers from opencode-swarm.json

## What changed

- The documented `harness_opt` and `skill_opt` configuration blocks now actually
  reach the registered `/swarm harness-opt run|compare` and
  `/swarm skill-opt plan|run` command handlers. Previously the registry
  closures dropped the loaded plugin config on the floor, the handlers fell
  back to reading the project root `opencode.json` — a file the swarm config
  loader never touches and no documentation mentions — so a user who enabled
  either block in `.opencode/opencode-swarm.json` (the only documented,
  schema-autocompleted, doctor-validated surface) was refused with
  `status: 'disabled'` telling them to do what they already did.
- With the fix, dispatch without an injected config — the standalone CLI path
  and the agent-invocable `swarm_command` tool path alike — resolves the block
  from `opencode-swarm.json` (project + user config, deep-merged) through the
  real config loader, the same surface as the registered path. (Threading the
  loaded config through the `swarm_command` tool dispatch itself remains open
  and is noted for the config-consumption ratchet follow-up, #2904.)
- The spend-budget guard (`max_spend_usd` → `spend_budget_exhausted`) and the
  comparative arm toggles (`run_ablation_arm` / `run_simple_agent_arm`) now
  resolve from the documented config on the registered path instead of
  silently falling back to defaults.
- With both blocks now genuinely consumed, `/swarm config doctor` is no longer
  the only line of defense for this family: an enabled block is enforced by
  the command path itself, and the config-consumption ratchet (#2904) treats
  the keys as consumed.

## Breaking / migration

- The undocumented `opencode.json` fallback (`harness_opt` / `skill_opt` blocks
  in the project root `opencode.json`, also accepted under a `swarm` key there)
  is **removed**. If you relied on it, move the block to
  `.opencode/opencode-swarm.json` (or your user-level config). When the block
  is absent entirely, the refusal now names the file:
  `harness_opt block not found in .opencode/opencode-swarm.json (project) or
  the user-level config — set harness_opt.enabled: true there to execute
  governed rounds` (same shape for `skill_opt`); a present-but-false block
  keeps the previous `enabled is false` wording.
- Note for `harness-opt compare`: the command has no `enabled` gate (by design
  it is human-gated via `--confirm` only). If you previously set
  `run_ablation_arm: false` / `run_simple_agent_arm: false` in the removed
  `opencode.json` location, those toggles silently revert to their `true`
  defaults until you move the block — `compare` gives no refusal prompt.
- A malformed `harness_opt`/`skill_opt` block is usually recovered per field:
  a wrong-typed value (e.g. `enabled: "banana"`) is sanitized to its default
  and the block still counts as present, so you get the accurate
  `enabled is false` message rather than "not found", and `/swarm config
  doctor` names the offending key. This does NOT hold in every recovery case:
  if the block itself has the wrong shape (a string/array instead of an
  object), if the project config fails validation while a user-level config
  exists (the loader then uses the user config alone), or if the project file
  cannot be parsed at all, the block is dropped with the rest of the config
  and the refusal is the "block not found" wording even though you wrote the
  block. The same applies if the config cannot be merged safely (for example
  a `__proto__` key anywhere in the file aborts the merge). Run
  `/swarm config doctor` to see which recovery applied; the fail-safe
  outcome in every case is `disabled`.

## Why

Frontier-audit finding K-1 (2026-09-23 run, verdict UPHELD, severity HIGH):
the plugin parsed, documented, schema'd, and doctor-validated both blocks,
but nothing on the registered command path consumed them. Fixes #2949
(Workstream J, PR 6 of 25) and feeds the config-consumption ratchet (#2904):
`harness_opt` and `skill_opt` are now consumed keys by construction.
