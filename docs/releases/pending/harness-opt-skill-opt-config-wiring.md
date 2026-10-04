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
- With the fix, dispatch without an injected config (the standalone CLI path)
  resolves the block from `opencode-swarm.json` (project + user config,
  deep-merged) through the real config loader — the same surface as the
  registered path.
- The spend-budget guard (`max_spend_usd` → `spend_budget_exhausted`) and the
  comparative arm toggles (`run_ablation_arm` / `run_simple_agent_arm`) now
  resolve from the documented config on the registered path instead of
  silently falling back to defaults.

## Breaking / migration

- The undocumented `opencode.json` fallback (`harness_opt` / `skill_opt` blocks
  in the project root `opencode.json`, also accepted under a `swarm` key there)
  is **removed**. If you relied on it, move the block to
  `.opencode/opencode-swarm.json` (or your user-level config). When the block
  is absent entirely, the refusal now names the file:
  `harness_opt block not found in opencode-swarm.json (project or user
  config) — set harness_opt.enabled: true there to execute governed rounds`
  (same shape for `skill_opt`); a present-but-false block keeps the previous
  `enabled is false` wording.
- A malformed block inside `opencode-swarm.json` is per-field sanitized by the
  config loader (the offending key is reported by `/swarm config doctor`) and
  the block still counts as present, so you get the accurate `enabled is
  false` message rather than a confusing "not found".

## Why

Frontier-audit finding K-1 (2026-09-23 run, verdict UPHELD, severity HIGH):
the plugin parsed, documented, schema'd, and doctor-validated both blocks,
but nothing on the registered command path consumed them. Fixes #2949
(Workstream J, PR 6 of 25) and feeds the config-consumption ratchet (#2904):
`harness_opt` and `skill_opt` are now consumed keys by construction.
