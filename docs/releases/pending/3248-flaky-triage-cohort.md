# 2026-10 flaky-test cohort: coverage drift posture, Windows teardown EBUSY, macOS probe re-quarantine, detector dedupe (issue #3248)

Issue: #3248

## What

Resolves the open "Auto-detected flaky tests (merge-group) — review for
quarantine" issue backlog: 84 issues in the triage cohort (2026-09-09..
2026-10-14) plus 2 more auto-filed while this change was in flight (86 at
publication; the detector dedupe below stops further duplicates). Triage
(per-run check-run annotations + validation artifacts from 16 sampled failed
merge-group runs) found three independent root-cause classes behind the
detections, plus one workflow defect that turned them into one issue per
failed run, plus two policy quarantine decisions and one production
follow-on the evidence demanded:

1. **Coverage-shard checkout-drift enforcement (the retry-flake wave).** The
   checkout-drift tripwire (#3146, 2026-10-08/09) enforces "creating `.swarm/`
   where none existed". The unit job pre-writes `.swarm/repository-validation/`
   manifests before tests; `scripts/ci/run-coverage-gate.sh` did not, so on
   every fresh coverage shard the first file whose execution materialized
   `.swarm/` (writers tracked in #3165-A) failed attempt 1 and passed the
   in-job retry — ubuntu/coverage-only retry-flakes riding along on every
   failed run (cli-version/commands/run-command: 22 detections each;
   delegation-gate-scope/guardrails-modified-files: 16 each). The gate now
   pre-creates `.swarm/coverage-gate/` with the shard file list (unit-job
   posture alignment; `coverage-gate` joins `IGNORED_SWARM_PREFIXES`). This is
   an interim alignment: #3165-A retires the writers and then flips the
   `.swarm` diff from warn to enforce, restoring creation detection — until
   then the coverage job cannot detect a test creating `.swarm/` where none
   existed (the same trade-off the unit job already accepts).
2. **Windows teardown EBUSY.** `safeRmRecursive`
   (tests/helpers/safe-test-dir.ts) retried EBUSY/EPERM/ENOTEMPTY on a flat
   ~2 s budget with GC only on the first attempt; windows-latest AV/cold-FS
   handle holds outlived it and hard-failed merge-group shards
   (close-active-state-unlink-retry: 21 detections, hard fail run
   38507292215). The budget is now a ~10 s deadline (100 attempts) with
   `collectGarbageBestEffort()` on every failed attempt (a hedge for
   GC-reclaimable handles; only elapsed time helps AV-held ones). The
   19-detection hydration-populate-guard flake was its raw-`rmSync` `afterAll`
   with no retry at all (hard fail run 38425263922, 3/3 attempts) — it now
   routes through `safeRmRecursive` (the PR #2190 / #2807 pattern). A
   recurrence sweep across all 77 flagged files found 27 further raw
   recursive-`rmSync` cleanup sites; they are dispositioned (not converted) in
   the tracker and deferred to follow-up (#3252).
   **Production follow-on:** `/swarm close`'s clean stage had the same
   too-short budget — `ACTIVE_STATE_UNLINK_RETRY_DELAYS_MS` grew from
   [25, 50, 100, 200] (~375 ms) to a ~15.2 s schedule, with GC on every
   failed attempt. Local instrumented Windows runs show the Bun sqlite
   handle release after `closeProjectDb` is bimodal (~5 ms or ~11 s); on the
   long tail the old schedule threw `EBUSY` from
   `unlinkActiveStateFileWithRetry` (observed ~3/10 local runs). The success
   path is unchanged — the extra budget is spent only where the old schedule
   produced an error. Worst case, a stuck artifact now delays `/swarm
   close`'s clean stage by up to ~15 s instead of failing it.
3. **macOS native-probe race (re-quarantine).** bun-compat-exit-first-2530
   (10 detections; hard fails on merge-group runs 38449931439 + 38421990284,
   both `unit (macos-latest, 5)`): the overflow child exits 0 before the kill
   lands — a different signature than the timeout flake the #2973 retirement
   cured, so the retirement absence-guard's "fresh merge-group macos-latest
   failure evidence" condition is met and the entry is re-added to the macOS
   ledger with OWNER/EXPIRY (retire on a nativeOutputLimitProbe root fix or
   three consecutive green macOS merge-group runs). Pin tests
   ci-yml-quarantine-2730/-2740 were reworked from retired→active pins.
4. **Windows retry-flake quarantine.** dispatch-lanes-pr-review-resilience-
   followups (9 detections, windows-latest retry-only evidence, no assertion
   text survives the retry loop) joins the windows ledger with OWNER/EXPIRY
   per the delegation-gate-background-coder retry-only precedent; the ledger's
   STATUS header now declares 3 active entries.
5. **Detector dedupe (stops the flood).** detect-and-quarantine-flakes.sh
   created a new issue per failed merge-group run. It now searches for an OPEN
   issue with the exact title (server-side `--search in:title`, gh
   `--template` extraction, no jq) and comments the full per-run candidate
   list plus the triggering run URL there, creating only when none is open.
   Concurrent detections can still race one duplicate (accepted, warn-only).

All 86 open detection issues (84 cohort + 2 in-flight filings) are
dispositioned in the tracker with per-file
evidence (root-fixed-by / quarantined-by / already-ledgered / stale).

## Why

Failed merge-group runs were being filed as duplicate issues continuously
(22 runs flagged the coverage cohort alone during 2026-10-09..14; 24 failed
runs in the final 36 hours of the triage window), and the two Windows/macOS
hard-failers were repeatedly ejecting PR groups from the queue. The classes
had concrete, evidenced root causes; quarantining the coverage-shard cohort
(5+ files including two core hooks suites) would have suppressed them
everywhere for an infrastructure bug.

## Migration

No config or API changes. Behavior note: `/swarm close`'s clean stage can now
spend up to ~15.2 s retrying a handle-locked artifact (previously it errored
after ~375 ms); the success path is unchanged. The quarantine entries carry
Check 7 OWNER/EXPIRY metadata (2026-11-15) with retirement criteria tracked
in #3248 (discharged by #3251 for the macOS entry); quarantined macOS files
are skipped only on macos-latest runners and the windows entry only on
windows-latest. Follow-ups: #3250 (coverage lcov aggregator failures),
#3251 (native-probe root fix), #3252 (windows single-hit diagnoses + the
27-site raw-`rmSync` hardening worklist), #3165-A (the `.swarm`-writer
cleanup that eventually restores the drift guard's full enforcement).
