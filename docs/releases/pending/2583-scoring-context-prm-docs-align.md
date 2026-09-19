---
issue: 2583
---

Corrects the scoring, context-budget, and PRM configuration documentation to match the runtime (issue #2583; documentation only — no runtime behavior changed):

- README scoring examples now use the real schema keys (`phase`, `current_task`, `blocked_task`, `recent_failure`, `recent_success`, `evidence_presence`, `decision_recency`, `dependency_proximity`); the previous `recency`/`relevance`/`importance` weights and `logs` token ratio never existed in the schema and were silently stripped to defaults.
- `context_budget.scoring.token_ratios` is now documented as accepted-but-inert: kept for backward compatibility, deprecated, and never read — normal and scoring token accounting always use the canonical estimator (`estimateTokens`, flat ~0.33 tokens/char), with provider-reported usage authoritative when available.
- README's context-budget "What This Does NOT Do" section now states the true contract: at the critical threshold with `enforce: true` (the default), the guard masks large completed tool outputs and prunes lower-priority messages **in the outgoing request only**; persisted history and on-disk tool results are never modified, and execution is never aborted. Warnings repeat per turn above the threshold (no once-per-session suppression), and the guard measures the whole conversation.
- `tool_output_mask_threshold` is documented everywhere as a character threshold (docs/installation.md previously said "token count").
- README's stale "not yet enforced at runtime" note about `max_trajectory_lines` and `escalation_enabled` is corrected — both are enforced at runtime.
- `prm_hard_stop_terminal` is added to the PRM telemetry event list in docs/evidence-and-telemetry.md, together with a record-populations and denominators table distinguishing hard-stop triggers, delivered denials, terminal events, host tool errors, and completed tasks (none is a causal task-failure rate without a bounded attempt denominator).
- New guardrail test `tests/unit/docs/config-examples-schema-parity.test.ts` validates every published `context_budget` JSON example in README.md and docs/installation.md against the zod schema that parses it, so fabricated keys cannot ship silently again.
