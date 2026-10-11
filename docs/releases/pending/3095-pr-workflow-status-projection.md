---
issue: 3095
title: pr_workflow_status exposes PR-review boundaries, lane coverage, and the candidate inventory
---

# `pr_workflow_status` exposes PR-review boundaries, lane coverage, and the candidate inventory (issue #3095)

When a PR_REVIEW workflow is active, `pr_workflow_status` now includes a bounded, read-only `gate.prReviewProjection` — the orchestrator no longer has to trigger a rejection to learn the authoritative inventory. The projection appears only for an active PR_REVIEW gate (never for PR_FEEDBACK or inactive gates).

## What changed

- **Boundary settlement (AC1):** three rows in fixed order (post_explorer / post_reviewer / post_critic), each `settled` or `pending`, carrying the persisted run id, the findings-artifact path, and — only on settled reviewer/critic rows — the persisted verdict-settlement digest.
- **Per-lane coverage (AC2):** one row per lane declared by the base dispatches (capped at 30 rows with a `laneCoverageTruncated` flag), each with the lane id, workflow lane, batch id, accepted-finding count and per-lane rejection count, and a one-line latest-finding marker (`<SEVERITY> <id>: <title>`, `clean`, `no-receipt`, `incomplete`, or `receipt-uncertain`).
- **Derived inventory (AC3):** the gate's existing candidate-inventory derivation, reused unchanged through a new fail-soft read accessor and bounded to 40 ids with `truncated`/`total`/`cap` fields (`inventory: null` when the derivation cannot run, e.g. an unbound head).
- **Read-time only (AC4):** every summary is derived at read time from persisted gate state and retained receipt envelopes; the tool run writes nothing.

## Details worth knowing

- Uncertain delegation-store reads surface as `receipt-uncertain` rows rather than `no-receipt` — the store's epistemic contract forbids reporting an unreadable store as an empty batch, mirroring the derivation's own "UNKNOWN, not absent" stance.
- `recordedPrReviewResultReceipt` is now exported from the delegation store so the status tool reads receipts through the same accessor the store's writers use.
- Existing `pr_workflow_status` fields and suites are unchanged (PRESERVING check green at base and head).
