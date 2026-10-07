---
issue: 2899
title: Release archive back-fill batch 1 and cleanup-tolerant release evidence
---

# Release archive back-fill batch 1 (#2899)

## What changed

- Materialized the exact GitHub Release bodies and fragment provenance for
  v7.167.0..v7.177.0 (batch 1 of the issue #2899 historical back-fill): 25
  versioned history files plus one-to-one manifests, produced by the
  documented exact-tag batch procedure with the provenance oracle untouched.
- Removed 46 consumed pending release-note fragments. Retrospective review
  (hash-verified against the manifests) corrected the original retained
  list: 2508-settlement-merge-safety-purge.md (re-consumed by v7.173.1
  with matching bytes) and 2670-startup-latency-contract.md (consumed by
  v7.176.0/v7.176.1) were also correctly deleted — every deletion across
  the three batches is manifest-referenced and byte-hash-verified. Only the
  three ci-*2552 fragments genuinely remain pending (bytes changed on main,
  no matching manifest).
- Carries the version-controlled historical replay-state artifact that
  authorizes the remaining batches (expires 2026-09-29).
- `recall-evaluation-docs-release-acceptance.test.ts` AC13 now accepts the
  #2489/#2490 release evidence either pending or materialized in the
  `docs/releases` archive — the fragment was consumed by v7.169.0, so the
  pending copy is correctly gone once the archive exists.

## Verification

- `verify-retention` on this branch: exit 0, no violation, 462 pending
  fragments (the runtime counter has no exclude-self convention), authorized
  historical replay in progress.
- The updated AC13 test passes against both the pending and materialized
  states.
