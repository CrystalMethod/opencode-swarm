---
issue: 3095
title: pr_workflow_status exposes PR-review boundaries, lane coverage, and the candidate inventory
---

# `pr_workflow_status` exposes PR-review boundaries, lane coverage, and the candidate inventory (issue #3095)

When a PR_REVIEW workflow is active, `pr_workflow_status` now includes a bounded, read-only `gate.prReviewProjection` — the orchestrator no longer has to trigger a rejection to learn the authoritative inventory. The projection appears only for an active PR_REVIEW gate (never for PR_FEEDBACK or inactive gates).

## What changed

- **Boundary settlement (AC1):** three rows in fixed order (post_explorer / post_reviewer / post_critic), each `settled` or `pending`, carrying the persisted run id, the findings-artifact path, and — only on settled reviewer/critic rows — the persisted verdict-settlement digest. The run id and findings path are a SHARED, last-write-wins reference, labelled in-band as `checkpointScope: 'shared-last-write-wins'` (the persisted schema has no per-boundary checkpoint), so the per-row reference cannot be misread as per-boundary evidence. `settled` reflects the boundary marker only — an N-of-M settlement that disclosed liveness-dead items still projects `settled`; the run's verdict-settlement receipt carries the dead-item disclosure.
- **Per-lane coverage (AC2):** one row per lane declared by the base dispatches (capped at 30 rows with a `laneCoverageTruncated` flag), each with the lane id, workflow lane, batch id, accepted-finding count and per-lane rejection count, a one-line latest-finding marker (`<SEVERITY> <id>: <title>`, `clean`, `no-receipt`, `incomplete`, or `receipt-uncertain`), and bounded finding summaries — the first 5 findings per lane (`findings` with `findingsTruncated`), each id/severity/title sanitized as a display copy while lane/batch identity keys stay raw for joins.
- **Derived inventory (AC3):** the gate's existing candidate-inventory derivation, reused unchanged through a new fail-soft read accessor. A typed union: `available` carries sanitized display copies of the first 40 ids with `truncated`/`total`/`cap`; `unavailable` carries a bounded, sanitized reason (e.g. an unbound head or an unreadable revision digest). The projected set is the FULL derived candidate inventory — the enforcement exact-cover set excludes reviewer-dead items, so the two can legitimately differ near settlement.
- **Read-time derivation (AC4):** every summary is derived at read time from persisted gate state and retained receipt envelopes; nothing is duplicated to disk. On the healthy path a settled run leaves the `.swarm` tree byte-identical (pinned by test), but the read is not free and not guaranteed write-free — see below.

## Disclosure (cost and admission)

- **Cost:** the inventory read runs the gate's revision-digest computation (three bounded git processes plus changed-file hashing) on every bound PR_REVIEW call, and the lane receipt lookup performs one delegation-store read per distinct emitted batch on top of the recovery section's own read. On a degraded store each such read retries once (25 ms) and appends to the durable delegation-health ledger; the gate-state read path can also repair/import shadow state. A status read can observably write.
- **Admission:** `laneCoverageAdmission: 'lane-record-only'` discloses that lane receipts are admitted on (batch, lane, mode, dual-head) identity only. The gate's enforcement admission additionally applies artifact-integrity checks (revision digest, source, digest, chars), the credited-lanes filter, and supersession. This is an observation surface, not an enforcement path.
- **Degradation:** uncertain or throwing delegation-store reads surface as `receipt-uncertain` rows rather than `no-receipt` — an unreadable store is UNKNOWN, not absent. When the recovery reader salvages a schema-invalid gate state and drops every PR-review field, the projection's `sources` mark `boundaries`/`laneCoverage` `unavailable` with a bounded reason (and the inventory refuses to fabricate the `CLEAN-REVIEW` sentinel) instead of reporting healthy-but-empty coverage.

## Details worth knowing

- `recordedPrReviewResultReceipt` is now exported from the delegation store so the status tool reads receipts through the same accessor the store's writers use.
- Existing `pr_workflow_status` fields are unchanged: the three pre-existing test suites pass identically before and after this change.
