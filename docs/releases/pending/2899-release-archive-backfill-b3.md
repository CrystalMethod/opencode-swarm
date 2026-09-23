---
issue: 2899
title: Release archive back-fill batch 3 (final) completes the v7.167.0..v7.186.0 history
---

# Release archive back-fill batch 3, final (#2899)

## What changed

- Materialized the exact GitHub Release bodies and fragment provenance for
  v7.184.10..v7.186.0 (final batch of the issue #2899 historical back-fill):
  11 versioned history files plus one-to-one manifests.
- Removed 19 consumed pending release-note fragments. Retrospective review
  (hash-verified) corrected the original report:
  2582-auto-checkpoint-threshold.md was NOT already absent — it existed at
  this batch's merge parent and was correctly deleted (its bytes
  hash-match the v7.184.12/v7.184.15 consuming manifests).
- Removes the historical replay-state artifact: the final tag (v7.186.0) has
  no continuation, closing the authorized replay window opened by batch 1.
- After this batch the docs/releases archive is complete for every tag in
  (v7.166.4, v7.186.1] and the pending count drops to 393 (limit 750,
  acceptance bound 600; the runtime counter includes this fragment itself).

## Verification

- `verify-retention` on this branch: exit 0, no violation, 393 pending,
  no byte-identical consumed fragments, replay state fully retired.
