# Post-abort partial-results export for PR reviews (issue #3097)

## What

A PR review that legitimately ends via `abort_pr_workflow` (bounded recovery)
had no authorized way to export its validated findings: the live handoff path
requires an active gate and couples to feedback consent, and
`pr_review_submission` refuses aborted runs by design ("aborted runs are out
of scope (#3097)"). This adds the missing third surface.

- New architect-only tool `export_pr_review_partial_results`
  (`src/tools/export-pr-review-partial-results.ts`): after the gate is cleared,
  exports the run's validated partial record to
  `.swarm/pr-review/<run_id>/post-abort-export.json` — bound per-item to the
  persisted, head-bound findings rows and the trigger-eval receipt, with
  workflow/head provenance (workflow instance from the run reservation, abort
  event timestamp, receipt base/head/evaluated_at).
- Fail-closed authorization ladder, each refusal typed: `invalid-session` →
  `gate-active`/`gate-indeterminate` (the gate must be GONE) →
  `not-aborted`/`abort-scan-indeterminate` (a `pr_workflow_aborted` event
  binding session + head is the PRECONDITION — the #3118 abort scan inverted;
  a truncated events window fails closed) → `reservation-mismatch` (the run
  reservation must belong to the calling session, closing the cross-session
  gap #3118 disclosed) → `receipt-missing`/`head-mismatch` → `no-findings`.
- Partial and non-authoritative by construction: the artifact carries
  `partial: true` / `authoritative: false`, and the rendered summary (built by
  reusing the #3118 pure renderer wrapped in a banner that explicitly negates
  submission/completion/consent) never claims full coverage — when no coverage
  disclosure exists, coverage is rendered as UNKNOWN, never FULL.
- Silence representation: assigned-but-receiptless families are listed as
  untested (MATCHED families with coverage degradations, canonical families
  absent from the trigger receipt, and MATCHED families whose cited lane was
  settled presumed-stale at abort), not-triggered families are listed
  separately, reached boundaries are disclosed, and an `abort_lane_state` band
  reports open/presumed-stale lanes without claiming them tested.
- Rider: the `abort_pr_workflow` tool description now documents the enforced
  500-character `reason` limit ("(max 500 chars)").
- Registered through the full tool set (metadata + manifest thunk + barrel);
  the retention registry's `pr-review-run-artifacts` row now covers
  `post-abort-export.json` (atomic temp+rename, findings-cap + 1 MiB bound,
  typed `artifact-too-large` refusal) and the pre-existing
  `run-reservation.json` omission.

## Why

Issue #3097 ([Workstream C] PR 2 of 2, epic #3102): a tier-L review with 44
classified candidates and durable artifacts ended via abort with no export of
its validated findings. Abort clears the gate; until now that also destroyed
exportability even though the validated artifacts survive on disk.

## Disclosed limits

- The abort event carries no `run_id`; binding is (session, head, receipt run
  id). Two aborted runs at the same head in one session are disambiguated only
  by the requested run's receipt/reservation.
- Family-level lane settlement receipts live in the delegation ledger, which
  this export deliberately does not read (self-contained reads per the issue;
  #3118 precedent); family silence derives from the trigger receipt's own
  coverage record, the presumed-stale lane join, and the `abort_lane_state`
  disclosure — no family-level settlement is claimed.
- Events older than the 3 MiB retained-events tail fail closed
  (`abort-scan-indeterminate`).
- The export never writes `feedback-consent.json` or `feedback-handoff.json`
  and never re-arms gate state; it refuses while a gate is active so it cannot
  become a parallel live path around the consent machinery.
