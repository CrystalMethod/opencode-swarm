# Renew the quarantine-ledger EXPIRY walls before they hard-fail the required quality job (issue #2900)

## What changed

- Renewed ALL 16 active quarantine-ledger entries across the three unit
  ledgers (`scripts/ci/quarantined-tests.txt` [3],
  `scripts/ci/quarantined-tests-windows.txt` [9],
  `scripts/ci/quarantined-tests-macos.txt` [4]) from their original
  2026-09-26..2026-10-31 EXPIRY dates to a uniform
  **EXPIRY 2026-11-18** with a testable per-entry retirement criterion.
  Entry paths, ledger placement, and the windows `# STATUS: 9 active
  entries` header are unchanged (no test stops or starts).
- Re-anchored every `# OWNER:` line to an OPEN issue so the renewal has a
  live tracking owner: the macOS `repository-validation-real-process-2675`
  entry stays with **#2738** (its root-cause owner); the other 15 entries
  point at the new umbrella cohort-retirement tracker **#2973**. The
  original (now closed) flake-evidence issues — #1982, #2185, #2660, #2692,
  #2730, #2740, #2761, #2812 — remain cited in each entry's history block.
- Each entry gained a `# Renewed 2026-09-25 per issue #2900 (Workstream I3);
  previous EXPIRY <old date>.` provenance line.

## Why

`bun run check:invariants` Check 7 hard-fails the required CI `quality` job
when any active ledger entry's EXPIRY is more than 14 days past
(`scripts/check-invariants.ts`, issue #2477). Twelve of the sixteen entries
expired or were expiring between 2026-09-26 and 2026-10-17, which would have
blocked **every non-release PR merge** starting 2026-10-11 (the macOS
`repository-validation-real-process-2675` entry), then progressively worse
through 2026-11-01 — and 15 of the 16 OWNER lines named already-CLOSED
issues, so nothing live was obligated to hold the renewal conversation the
EXPIRY mechanism exists to force.

The renewal defuses the wall (next hard-fail 2026-12-03) and hands each
entry to a tracked retirement path: #2738 owns the macOS signal-fixture root
fix; #2973 tracks the full 16-entry cohort with per-entry criteria and is
the input to the I8 census/aging workstream (#2905). No flaky test was
un-quarantined: every one of the 16 flakes is CI-runner-hostile with no
locally verifiable root fix, and each keeps its testable retirement
criterion in the ledger.

## Coordinates with

- #2834, #2857, #2861, #2874 (open auto-fix PRs adding windows entries with
  EXPIRY 2026-10-17..10-20, which would re-arm the wall on 2026-11-01..04):
  coordination comments request EXPIRY >= 2026-11-18 and a #2973 anchor on
  rebase; this PR's edits touch only existing entry comment blocks, so the
  diffs merge cleanly in either order.
- #2738 (root-fix owner for the earliest-expiring entry) and #2973 (cohort
  retirement tracker) take over from here.

## Known caveats

- Check 7 will warn about these entries from 2026-11-19 and hard-fail from
  2026-12-03 if the cohort is not retired or re-dispositioned by then — that
  is the designed forcing function doing its job, now with open anchors.
