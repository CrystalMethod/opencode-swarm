# PR-review dead-family retry-budget enforcement (issue #2878)

## What

- **Persisted per-family micro dispatch attempt ledger.** Every
  `dispatch_lanes_async` micro-mode acknowledgment now appends one record to
  `prReviewMicroFamilyDispatches` in PR-workflow gate state
  (`{batchId, prHeadSha, lanes: [{laneId, workflowLane,
  ownedWorkflowLanes when non-empty}], admittedAt}`), recorded after the trigger-ledger bind and strictly before
  any lane session is created. The ledger is batchId-idempotent (a crash-retry
  of the same dispatch call never double-counts) and bounded at
  `MAX_WORKFLOW_BATCHES` (128) with a fail-closed BLOCKED refusal at the cap —
  never silent eviction.
- **Dead-family admission now proves retry-budget exhaustion mechanically.**
  `write_pr_review_trigger_eval` splits its `livenessTerminalDead` predicate:
  the durable record-shape conjuncts are unchanged, and a new conjunct
  requires three recorded dispatch attempts (initial dispatch plus
  `PR_REVIEW_MICRO_FAMILY_RETRY_BUDGET` = 2 retries) for the cited family
  under the same `pr_head_sha`, with the cited batch among the counted
  attempts. Below the budget — or when the cited batch is not among them —
  the admission fails closed with an actionable message naming the recorded
  count and the recovery paths (re-dispatch the family; each acknowledgment
  records one attempt, or `abort_pr_workflow`). The #2840 TOCTOU fresh re-read
  also re-reads the gate state and re-proves exhaustion at the decision
  moment, and the disclosure's `reason` string now carries the attempt
  evidence (append-only; the #2835 disclosure wording is preserved verbatim).
- **Skill prose updated to the enforced semantics** (canonical `.opencode`
  tree; SKILL.md edited line-neutrally against the 2024-line
  progressive-disclosure ratchet, detail expanded in
  `references/lane-output-recoverability.md` including the crash-window
  disposition of the ledger).

## Why

Issue #2835's AC #1 scoped dead-family disclosure to apply only "after the
bounded retry budget … is exhausted", but no attempt/retry counter existed
anywhere in `BackgroundDelegationResult` or gate state — the 2-retry budget
was prose-only and the admission (from PR #2836) disclosed a first-dispatch
liveness death immediately. This residual was filed as #2878 by #2840's
verification. The fix follows the base-lane precedent (`prReviewResilience`
wave attempts persisted in gate state): a workflow dispatch budget is
run-scoped gate state, not a transient-retry counter (those remain
invocation-owned per issue #2034 req 9 — the delegation store is unchanged).

## Notes

- Runs whose gate state predates this change have no recorded attempts, so a
  dead-family disclosure for them fails closed until the family is re-issued
  three dispatches under the new acknowledgment (bounded, run-scoped; the safe
  direction — pre-#2836 behavior for that shape).
- New tests: `dispatch-lanes-micro-family-dispatch-record-2878.test.ts`
  (recording, restart durability, idempotence),
  `write-pr-review-trigger-eval-retry-exhaustion-2878.test.ts` (fail-closed
  below budget / foreign cited batch),
  `write-pr-review-trigger-eval-exhausted-admission-2878.test.ts`
  (exhausted-budget admission with attempt evidence), and
  `pr-workflow-gate-micro-family-dispatch-cap-2878.test.ts` (cap + crash-window
  documentation pins). The three existing dead-family suites record the
  exhausted budget through the real recording function.
