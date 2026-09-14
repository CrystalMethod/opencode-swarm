# Render swarm guidance for strict single-system providers without breaking caching

Issue: #2673

## What changed

- **System render boundary** (`src/hooks/system-render-boundary.ts`, registered last in the `experimental.chat.system.transform` chain): the per-request rendering capability is now resolved from the model the host hands the boundary. Strict single-system models (the documented Qwen3.6/Gemma class from the v6.85.1 incident) get the system surface collapsed — in place, no content loss — to exactly ONE entry, so the rendered request carries exactly one `role:'system'` message. Cache-capable providers (`anthropic*`) and everything unknown are left byte-identical, preserving the host's prompt-cache breakpoints on the first two system messages. The ladder is symmetric: the cache-capable provider veto runs first, so a strict-family model id behind an Anthropic-compatible gateway is never collapsed.
- **Deterministic failure interpretation**: a provider rejection caused by an invalid request shape (for example "Only a single system message is supported") now classifies as `provider.request_shape` / `do_not_retry` instead of falling through to `provider.unknown` — bounded, operator-understandable, and provably never matched by the transient/generic-retry path (`REQUEST_SHAPE_REJECTION_PATTERN` in `src/utils/provider-error-classification.ts`).
- **Documentation**: `docs/engineering-invariants.md` gains the "Issue #2673 — system render capability at the final request boundary" entry (capability ladder, carrier interplay, failure interpretation, known limitation), and the v6.85.1 residual now points at it. The stale `buildSpecDriftAdvisory` docstring claim about surviving "the single-system-message collapse" was rewritten for the capability-conditional reality.

## Why

Strict single-system providers crashed or silently degraded on every architect turn: the pinned host materializes one system message per `output.system` entry, the plugin's guidance producers append entries, and nothing resolved the target provider's rendering capability — so the strict class received exactly two system messages, model-independent. An unconditional collapse had been deliberately removed (#1619) because it would move prompt-cache breakpoints behind varying content; this fix is conditional on resolved capability instead, which fixes the strict class without touching anyone else.

## Known limitation

Host request paths that bypass `output.system` (OpenAI OAuth and workflow models use `options.instructions`) cannot be shaped by a plugin hook and remain outside this boundary.

## Tests

- `tests/unit/hooks/system-render-boundary.test.ts` — capability ladder (strict families, segment anchoring, gateway-relabel symmetry locks, fail-open defaults), in-place collapse identity, exact join separator, empty-entry filtering, multi-system byte-identity, hook-level fail-open paths.
- `tests/integration/system-render-boundary-registered.test.ts` — registered-host journeys: strict architect/build/auxiliary requests render exactly one system message with guidance retained; guidance-free turns stay byte-identical; cache-capable architect keeps the stable-header-first two-entry shape.
- `tests/unit/failures/invocation-failure-request-shape.test.ts` — exact `provider.request_shape` classification, variant phrasings, transient-pattern negative controls, shell-text fallthrough unchanged.
- `tests/unit/hooks/hook-composition-order.test.ts` — new pin: the boundary runs after the role filter (last position).
