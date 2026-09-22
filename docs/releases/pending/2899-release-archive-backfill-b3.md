---
issue: 2899
title: Release archive back-fill batch 3 (final) completes the v7.167.0..v7.186.0 history
---

## What changed

- Materialized the exact GitHub Release bodies and fragment provenance for
  v7.184.10..v7.186.0 (final batch of the issue #2899 historical back-fill):
  11 versioned history files plus one-to-one manifests.
- Removed 19 consumed pending release-note fragments whose bytes still
  hash-match their tagged provenance; 1 referenced fragment
  (2582-auto-checkpoint-threshold.md, consumed by v7.184.15) was already
  absent on main and is retained by definition.
- Removes the historical replay-state artifact: the final tag (v7.186.0) has
  no continuation, closing the authorized replay window opened by batch 1.
- After this batch the docs/releases archive is complete for every tag in
  (v7.166.4, v7.186.1] and the pending count drops to 392 (limit 750,
  acceptance bound 600).

## Verification

- `verify-retention` on this branch: exit 0, no violation, 392 pending,
  no byte-identical consumed fragments, replay state fully retired.
