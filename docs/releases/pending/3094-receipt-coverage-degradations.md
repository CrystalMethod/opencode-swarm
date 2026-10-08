# Receipt-settled PR-review lanes no longer record false coverage degradations

A PR-review run whose micro families were settled through structured
`submit_pr_review_result` receipts no longer records spurious
`no covered candidate or clean row` coverage degradations — the exact defect
that forced fully receipt-settled reviews into spurious REQUEST_CHANGES and
made verdict APPROVE unreachable (issue #3094).

## What changed

- `write_pr_review_trigger_eval` now credits family coverage from the cited
  lane's structured receipt through the same exact-identity validator the
  workflow gate uses (`validateExactStructuredReceiptCoverage`, now exported
  from `pr-workflow-gate`): schema parse plus the full workflow/batch/lane/
  child/base/head/digest conjunction, crediting only
  `envelope.creditedLanes` members. Receipt-less, invalid, identity-mismatched,
  and unresolved families keep the previous transcript-based behavior exactly.
- For an accepted-and-credited family the writer suppresses the entire
  degradation-reason set (coverage AND transcript-quality reasons): the
  structured envelope is the authoritative settlement and takes precedence
  over transcript text, so truncation/degraded-output flags on a settled
  family no longer forbid APPROVE.
- Receipt-covered families are disclosed on the durable trigger receipt as a
  distinct, non-degrading class — new additive field
  `receipt_covered_families: [{trigger_id, source_batch_id, source_lane_id}]`
  (schema `.default([])`, so existing receipts keep parsing). The frozen
  ledger digest over trigger rows is untouched.
- Receipt replay across the schema boundary is normalized
  (`comparableTriggerReceipt` materializes the absent field), so an
  idempotent re-run of a pre-existing run still replays instead of failing
  with conflicting content.
- The writer response now carries `receipt_covered_family_count`, the
  `receipt_covered_families` array, and a disclosure note instructing the final
  review report to surface receipt-settled families as receipt-covered (not
  transcript-covered, not degraded).

## Why

Before this fix, a tier-L review where every MATCHED family settled via
structured receipts received one false coverage degradation per family; any
non-empty `coverage_degradations` forbids verdict APPROVE (v7.185.1), so the
run could only end REQUEST_CHANGES/INCOMPLETE despite being fully settled.
