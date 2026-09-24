---
title: Docs-only pre_check batches pass via vacuous secretscan coverage
issue: 2918
---

## What changed

A files-mode `pre_check_batch` whose every requested file is deliberately
skipped by secretscan scan policy (extension exclusion) no longer trips
the zero-coverage fail-closed arm forever when the skip is docs-safe:
markdown-family policy exclusions, per the `.md`/`.markdown`/`.mdx`
docs-safe allowlist. Today `.md` is the only extension both policy-excluded
and docs-safe — `.markdown`/`.mdx` remain content-scanned and can still
hard-fail on embedded secrets — so `.md`-only batches are the shape that
passes. Such a batch is now recognized as VACUOUS COVERAGE and passes the
hard gates, with the secretscan summary naming it explicitly ("all N
requested file(s) skipped by secretscan scan policy (vacuous coverage)").
Policy exclusions that are NOT docs-safe — binaries, archives, and
secret-bearing containers like `.db`/`.sqlite`/`.dat`/`.bin`/`.lock`/
`.log` — never count toward the pass: a batch made up solely of such files
still fails the zero-coverage arm. This aligns the pre_check hard gates
with the repo's existing docs-only semantics (the markdown-only
test_engineer gate exemption).

The same vacuous-coverage predicate is enforced at every site that
previously treated `files_scanned === 0` as a failure:

- the batch gate (`evaluateSecretscanGate`),
- the hook decoder (`hardGateExplicitlyFailed` in
  `src/hooks/guardrails/pre-check-result.ts`) — a tool-side-only fix would
  have produced a pass the decoder rejects as invalid, leaving the task
  wedged with a different code,
- `check_gate_status` secretscan evidence evaluation (the vacuous shape now
  reports satisfied with an advisory note instead of BLOCKED),
- the stage-a repair greenness check (`hasGreenPostSettlementPreCheck`).

The biome lint leg's message is now honest: when biome exits 1 because "No
files were processed" (all specified paths ignored by its configuration),
the message reads "biome check processed no files (all specified paths
ignored by biome configuration)" instead of the false "check found issues".
Lint remains informational and never blocks `gates_passed`.

## Notes

- One normative predicate everywhere, evaluated over the scan result /
  evidence fields: `files_scanned === 0 && policy_skipped_files >=
  requested_files && requested_files > 0 && count === 0 && findings empty &&
  incomplete_files === 0 && incomplete_paths empty`. `SecretscanResult` and
  `SecretscanEvidence` gained the additive counters `policy_skipped_files`
  and `requested_files` (optional on the evidence schema, so legacy
  persisted evidence decodes unchanged).
- Fail-closed floors are preserved and pinned: a result or evidence entry
  MISSING the new fields is non-vacuous (previous fail-closed behavior) and
  never invalid; findings, incomplete coverage, and findings/count mismatch
  still fail.
- The producer accounting was tightened so the pass is unforgeable: the
  extension-exclusion site is the ONLY `policy_skipped_files` increment
  site. A requested-but-missing file now counts as incomplete coverage with
  reason `missing` (lstat and realpath ENOENT), a non-string entry as
  `invalid_entry`, a binary-content `.txt` skip does not increment the
  policy counter, and the gate's request basis is the RAW pre-drop declared
  count (`requested_files`), so a validation-dropped entry keeps requested
  above the policy counter and fails closed.
- The F-002 vacuous-pass guard pin (an all-excluded batch must fail) is
  narrowed to docs-safe types: only docs-safe policy exclusions count
  toward vacuous coverage, so an all-`.png` batch still fails closed
  exactly as F-002 originally pinned. F-002's target — a scan that scanned
  nothing REPORTING success — remains fail-closed for every non-docs
  subclass; the docs-safe pass is surfaced via the dedicated counter and
  summary.
- The standalone directory-mode scan (`secretscan` / preflight) populates
  the new counters with 0/0 and stays strictly fail-closed on zero
  scannable files — directory mode never feeds the vacuous predicate.
