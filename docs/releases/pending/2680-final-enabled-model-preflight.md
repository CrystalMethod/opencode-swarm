# `fix(agents)`: validate final enabled swarm model selections and fallbacks during preflight

Issue: #2680

## What

- The model preflight now validates the **final effective model selection of every enabled role** — legacy unprefixed and multi-swarm prefixed (`swarms.<id>.agents.<role>.model`) — by reusing the shipped exact-name resolution helpers, instead of only reading top-level `agents` overrides plus a blanket `DEFAULT_MODELS` pass that missed per-swarm overrides and warned about roles that cannot dispatch.
- Disabled roles and feature-gated optional roles (`council.*`, `docs_design`, `designer` while their flags are off) are never collected, so preflight warnings carry no consumer-default noise; primary (architect) roles classify as `host-controlled` and stay silent — OpenCode's UI owns their selection.
- New distinct bounded outcome classes with actionable diagnostics: `missing-selection` (enabled role with no final selection — catalog-independent) alongside the existing provider/model `unresolved` classes; explicit `fallback_models` entries are validated as their own recorded class and are never synthesized.
- Dispatch admission now covers **every registered swarm agent**, not just critics: a Task dispatch whose final selection is positively `unresolved` is denied with `SWARM_AGENT_MODEL_UNRESOLVED` (critics keep the `PLAN_CRITIC_MODEL_UNRESOLVED` identity); a role with no final selection is denied with `SWARM_AGENT_MODEL_MISSING_SELECTION`. Primary agents are exempt (short-circuit before any catalog lookup) and an unreachable catalog never denies a dispatch — a catalog warning alone is not dispatch-failure evidence.
- `/swarm doctor` reports failing selections with configured/enabled/resolved/fallback distinctions and per-class operator actions (bounded to 20 rows).

## Why

A per-swarm model override pointing at a missing provider or model was invisible to every preflight surface: the startup warning stayed silent, `/swarm doctor` missed it, and the first observed failure was a permanent dispatch error with no typed preflight class. The #2271 preflight was built for top-level-config-only deployments and never followed multi-swarm generation.

## Notes

- `collectConfiguredAgentModels` remains exported unchanged for compatibility; `runModelPreflight` accepts an optional options object carrying the live generated-name registry.
- The deferred catalog fetch stays bounded (2 s timeout, 30 s TTL cache) and fail-open; no network call was added to plugin startup.
- Issue #2614's unregistered-lane dispatch refusal is untouched.
- Documentation: new "Model preflight" section in `docs/configuration.md` covering configured vs enabled vs resolved vs fallback, prefixed names, optional-role gating, and operator actions.
