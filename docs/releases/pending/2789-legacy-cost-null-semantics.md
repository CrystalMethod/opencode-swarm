# Issue 2789: null-preserving unknown semantics for legacy cost surfaces

## What changed

The legacy cost surfaces no longer zero-default absent token usage. Before this change, a delegation whose producer never held a token value was recorded — and rendered — as `0` tokens, indistinguishable from a delegation that used exactly zero tokens:

- `delegation_end` telemetry (`src/telemetry.ts` `delegationEnd`) now emits `tokens_input` / `tokens_output` / `tokens_reasoning` / `tokens_cache` as `null` when the producer did not hold the value, matching the `cost_usd ?? null` precedent in the same payload. Known numbers — including an explicit `0` — pass through verbatim as known values. The emit-line-parity golden corpus was regenerated deliberately at this commit (`scripts/capture-telemetry-golden.ts`).
- The cost fold (`src/services/cost-accounting.ts`) keeps unknown null end-to-end: `TokenUsage` axes are `number | null`, `readFiniteNonNegative(...)` results are no longer collapsed with `?? 0`, the `ZERO_USAGE` seed is replaced by an all-unknown seed, and `mergeUsage` folds unknown + unknown to unknown (a known value always beats unknown). Correction digests are unchanged for existing lines (the digest's null→0 canonicalization is pinned and documented in place), and the correction upgrade rule treats unknown as lower authority than known.
- The synthesized `missing_cost` evidence item now carries an all-null (unknown) usage instead of a zero-filled one.
- `/swarm costs` renders unknown token axes as the literal word `unknown` (never a fabricated `0`) in the summary line and every table row, and its `--json` output adds `unknown_usage_delegations` — the count of delegations whose token axes were all unknown. Token totals are sums over known contributions; a total is `null` only when no delegation held a known value for that axis (an empty directory still reports numeric zeros). The review report cost line renders unknown axes the same way.
- The review evidence cost block (`AutoReviewEvidence.cost`) accumulates only known contributions: an all-unknown dispatch set leaves its token axes `null`.
- The late-cost-correction recovery readback preserves unknown instead of coercing to `0`.
- `execution_attempt_recorded` (#2676) is unchanged: when a reported-cost delegation lacks a token axis, the axis is now omitted from the attempt (recorded as unavailable) instead of leaking a fabricated 0.

## Why

`src/observability/legacy.ts` rule 5 ("Unknown is not zero") already codified the target semantics; the legacy surfaces pre-dated them. The zero-default conflated "the producer did not hold this value" with "zero used" across `/swarm costs`, review cost sections, and the `delegation_end` payload, making the data unusable for usage questions. Historical lines are not back-filled: a recorded `0` stays a known zero, and recorded numbers keep their meaning.
