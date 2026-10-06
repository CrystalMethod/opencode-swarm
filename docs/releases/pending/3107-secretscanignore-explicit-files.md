---
issue: 3107
---

# secretscan: honor .secretscanignore on the explicit-files path (pre_check_batch changed-file gate)

## What changed

`runSecretscanOnFiles` — the secretscan engine `pre_check_batch` uses for its
changed-file Stage-A hard gate — now reads `.secretscanignore` at the scan root
and applies it with the same pattern language and precedence as the directory
scan (#152): exact names and glob/path patterns, comments and blank lines
skipped, unsafe patterns (path traversal, negation, absolute) silently skipped.
Ancestor directories prune like traversal, so a plain-name pattern such as
`generated` suppresses `a/generated/x.txt` at any depth — directory-path
parity is pinned by a permanent test that runs both engines on the same
fixture.

## Why

Repository-configured exclusions were silently not applied to exactly the
scans that gate coder work: the ignore file was loaded only on the
directory-scan path (`loadSecretScanIgnore` had a single call site), so
findings the owner explicitly ignored still appeared in — and blocked —
changed-file scans.

## Fail-closed accounting preserved (#2918)

Ignore suppressions increment `skipped_files` only — never
`policy_skipped_files` — so the vacuous-coverage predicate's meaning is
unchanged at all four enforcing sites (gate, decoder, `check_gate_status`,
stage-a-repair) and a batch whose every requested file is ignore-suppressed
still fails the gate via the existing "zero requested files scanned" arm. A
repo-writable `.secretscanignore` (e.g. `**/*`) can therefore never
vacuous-pass the changed-file gate. The extension-exclusion route is
evaluated first and unchanged: a docs-safe ignore-matched file keeps the
same #2918 accounting and outcome it has at base (pinned by test).
Ignore-matched missing files, symlinks, and scope-escaping realpaths keep
their incomplete fail-closed accounting — the ignore check sits after every
coverage/security route.

Two scoping notes: requested-file truncation (`MAX_EXPLICIT_FILES_SCANNED`)
is evaluated before ignore filtering, so ignore-matched files consume scan
slots and overflow stays fail-closed via incomplete coverage; and ignore
semantics are secretscan-gate-scoped — other gates over the same batch
(sast_scan) do not read the ignore file.

## Footprint

- `src/tools/secretscan.ts` — ignore load+merge per call, per-file exclusion
  check with ancestor pruning, skip accounting, doc comments.
- `tests/unit/tools/secretscan-ignore-explicit-files.test.ts` — new suite
  (parity, semantics, fail-closed pins, ext-first overlap pin, real-batch
  gate tests).
