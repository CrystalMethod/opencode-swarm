---
issue: 2973
---

# Retire 13 of the 16 renewed quarantine-ledger entries (#2973)

## What changed

The #2973 I3 renewal cohort held 16 flaky-test quarantine entries (EXPIRY 2026-11-18).
This PR retires 13 of them — every entry whose EXPIRY criterion's named root fix either
had already landed or lands in this PR — and re-runs the files in CI as the retirement
evidence:

- **Windows ledger (9 → 0 active entries):** `pr-monitor-status` (freezeClock +
  EBUSY-retry landed via #2190; its residual default-cap sensitivity under heavy
  host load is disclosed in the PR — the detect-and-quarantine workflow is the
  safety net),
  `index-pr-workflow-session-lifecycle-2602` and `phase-complete.lock-adversarial`
  (safeRmRecursive landed via #2807), `win32-wrapper-runtime` (per-test floor,
  spawnSync margins, safeRmRecursive teardown), `completion-observer-coder`
  (git-spawn timeout 5s → 20s), `pr-subscriptions-checkpoint` (POLLS 300 → 200,
  safeRmRecursive teardown), `recall-evaluation-profile-isolation` (per-test cap
  15s → 60s), `archive` and `write-receipts-feedback-2500` (safeRmRecursive teardown).
- **macOS ledger (4 → 2):** `bun-compat-exit-first-2530` (PROBE_TIMEOUT_MS 5s → 30s)
  and `promote-registration` (canonicalMkdtemp + safeRmRecursive)
  retire. `repository-validation-real-process-2675` stays (owned by open #2738) and
  `pr-feedback-scope-controller` stays (no reproducing diagnosis yet).
- **General ledger (3 → 1):** `evidence-summary-adversarial` (slow-handler budget
  500ms → 2000ms; the real setTimeout stays unfrozen per the deadline-wait rule) and
  `pr-workflow-gate-batch-gc` (CAP_TEST_TIMEOUT_MS 60s → 150s) retire.
  `init-rehome` stays (no diagnosis; its three-consecutive-green-coverage-runs
  criterion can only be satisfied by a dedicated post-removal experiment).

Three of the flake classes were reproduced live during the trace (win32-wrapper and
pr-monitor-status on the dev host; bun-compat under load during the frozen-check
freeze runs), so the applied remedies are evidence-backed, not speculative.

## Why

Retiring an entry is the only mechanism that restarts CI execution of a quarantined
file; the entries whose criteria were already satisfiable were stranded skips. The
ledger pinning tests are flipped to absence guards (with three new guards for the
previously-unpinned rows: pr-monitor-status, pr-subscriptions-checkpoint,
recall-evaluation-profile-isolation), so silently re-adding any retired entry without fresh
merge-group failure evidence now fails a test. Because this PR touches `scripts/`,
the detect-paths job opts the pull_request tier into the full 3-OS × 6-shard unit
matrix — the retired files run on windows-latest and macos-latest before the merge
queue, and merge_group re-proves them.

## Notes

- The umbrella #2973 stays open with rows 1 (#2738), 12 (init-rehome), and
  16 (pr-feedback-scope-controller); a per-row audit comment tracks each disposition.
- Merge-order note: open PRs #2834/#2857/#2861/#2874 add NEW windows-ledger entries;
  whichever side merges second rebases and recomputes the pinned STATUS count.
- Follow-up: after this merges, watch the retired files' first merge-group rounds; a
  re-flake re-quarantines with fresh evidence per the #1782 convention.
