---
issue: 2899
title: Release archive back-fill batch 2 and cleanup-tolerant MCP release evidence
---

# Release archive back-fill batch 2 (#2899)

## What changed

- Materialized the exact GitHub Release bodies and fragment provenance for
  v7.177.1..v7.184.9 (batch 2 of the issue #2899 historical back-fill): 25
  versioned history files plus one-to-one manifests, produced by the
  documented exact-tag batch procedure with the provenance oracle untouched.
- Removed 53 consumed pending release-note fragments. Retrospective review
  (hash-verified) corrected the original retained list:
  issue-2667-hydration-project-owned-generation-fenced.md and
  2580-plan-cursor-both-context-paths.md were also correctly deleted —
  their parent-tree bytes matched a later consuming manifest (v7.184.1 and
  v7.184.9 respectively), so they fall under the same byte-identical rule.
- Advances the version-controlled historical replay-state artifact to name
  v7.184.9 (expires 2026-09-29); the final batch's last tag will remove it.
- `acceptance-2500.test.ts` AC9 now accepts the #2500 release evidence either
  pending or referenced by a materialized manifest — the fragment was consumed
  by v7.178.0, so the pending copy is correctly gone once the archive exists.

## Verification

- `verify-retention` on this branch: exit 0, no violation, authorized
  historical replay in progress.
- The updated AC9 test passes against both the pending and materialized
  states.
