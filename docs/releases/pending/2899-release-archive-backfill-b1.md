---
issue: 2899
title: Release archive back-fill batch 1 and cleanup-tolerant release evidence
---

## What changed

- Materialized the exact GitHub Release bodies and fragment provenance for
  v7.167.0..v7.177.0 (batch 1 of the issue #2899 historical back-fill): 25
  versioned history files plus one-to-one manifests, produced by the
  documented exact-tag batch procedure with the provenance oracle untouched.
- Removed 46 consumed pending release-note fragments whose bytes still
  hash-match their tagged provenance; 5 changed-on-main fragments and 1
  already-absent fragment were retained and reported.
- Carries the version-controlled historical replay-state artifact that
  authorizes the remaining batches (expires 2026-09-29).
- `recall-evaluation-docs-release-acceptance.test.ts` AC13 now accepts the
  #2489/#2490 release evidence either pending or materialized in the
  `docs/releases` archive — the fragment was consumed by v7.169.0, so the
  pending copy is correctly gone once the archive exists.

## Verification

- `verify-retention` on this branch: exit 0, no violation, 461 pending
  fragments, authorized historical replay in progress.
- The updated AC13 test passes against both the pending and materialized
  states.
