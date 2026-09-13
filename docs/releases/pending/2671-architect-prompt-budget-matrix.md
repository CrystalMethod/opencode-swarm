# Architect prompt budget across supported feature combinations (#2671)

- The architect prompt budget is now enforced across the full supported
  feature matrix, including the advisory General Council composed together
  with every documented opt-in. Composing `council.general.enabled` with the
  other supported features previously rendered past the published
  `ARCHITECT_PROMPT_BUDGET_CHARS` ceiling (161,239-162,386 chars measured
  against the 161,000 ceiling) with no failing signal, because the existing
  regression test never enabled the general council.
- Tool descriptions in the architect prompt's AVAILABLE TOOLS line now render
  capped at 240 characters with a visible ellipsis marker, bringing every
  supported composition back under the ceiling without dropping mandatory
  guidance. The tool-registration surface is untouched — the model still
  receives full tool descriptions through the tools API.
- New budget accounting exports in `src/agents/architect.ts`:
  `estimateModelTokens` (~4 chars/token estimate — model tokens are measured
  and recorded as a quantity separate from the authoritative character count),
  `measureArchitectPromptBudget`, and `enforceArchitectPromptBudget`, which
  returns a bounded `ARCHITECT_PROMPT_BUDGET_EXCEEDED` configuration error
  (at most 400 chars) for over-budget compositions instead of silently
  dropping guidance.
- Runtime enforcement: the composed architect prompt is measured at factory
  exit and again after multi-swarm sentinel substitution, so an extreme
  user-supplied swarm name cannot silently bypass the cap — the violation
  surfaces as a visible advisory in `/swarm diagnose` while the full prompt
  (including the phase-completion lifecycle gate instructions) is kept.
- Documentation: `docs/configuration.md` gains an "Architect prompt budget
  (characters and model tokens)" section covering the ceiling, the
  chars-vs-tokens distinction, the supported-together feature matrix, and the
  overflow policy; `docs/architecture.md` documents the composition
  accounting.
