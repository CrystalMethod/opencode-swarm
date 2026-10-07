## What changed

`pre_check_batch`'s secretscan hard gate is now diff-scoped: findings classify
as NEW (on coder-changed lines) or PRE-EXISTING (on untouched lines of files
the batch touched) against the same changed-line map the SAST legacy path
consumes, and only NEW secrets fail the gate. Pre-existing findings stay
fully visible in the scan result and persisted evidence and surface as an
advisory — a brownfield repository with committed secrets can now go green
without a repo-wide ignore list.

## Why

In any repository with pre-existing secrets in tracked files, the gate failed
on every run forever, blocking tasks at Stage A with no path forward except
`.secretscanignore` (#3092).

## Fail-closed contract

- A finding is PRE-EXISTING only when the changed-line map is non-null, the
  file key is present, the set is non-empty, it does not carry the
  ALL_LINES_CHANGED sentinel, and the finding's line is a safe positive
  integer NOT in the set. Everything else — missing key, empty set, null map
  (git unavailable), unresolvable/zero/negative/non-integer lines, malformed
  or root-escaping paths — is NEW.
- `classifySecretFindings` never throws; any resolution failure classifies as
  NEW. It intentionally diverges from `classifySastFindings` (whose
  missing-key/empty-set arms are pinned intentional for SAST).
- Files whose changed-line evidence mixes more than one Git hop (committed
  and/or staged changes plus a later staged/unstaged edit) classify ALL their
  findings as NEW: the changed-line map unions diffs written in HEAD/index/
  worktree coordinates while findings carry worktree line numbers, so a
  staged-or-committed secret shifted by a later insertion above it can never
  prove itself pre-existing. If the ambiguity source is unavailable, nothing
  gets the pre-existing discount.
- Truncation now gates: `runSecretscanOnFiles` discloses a cap hit in
  `message` (`Results limited to 100 findings`, directory-path parity) and
  sets `truncated: true` on both scan paths, including the final-file
  in-place trim that previously dropped findings silently; the gate, the hook
  decoder, and the consumers fail closed on it.
- The hook decoder accepts a passed secretscan carrying findings ONLY when
  the batch result carries `secretscan_preexisting_findings` multiset-covering
  the total set; truncation, count/findings mismatch, incomplete coverage, and
  zero coverage still block regardless of proof.
- Evidence gains optional `new_findings_count`, `preexisting_findings_count`,
  and `diff_scoped` fields (legacy evidence decodes unchanged).
  `check_gate_status` and `hasGreenPostSettlementPreCheck` gate on
  `new_findings_count` when present (0 preserved — no truthiness fallback) and
  fall back to the total `findings_count` on legacy evidence. The #2918
  vacuous-coverage predicate stays keyed on totals at every site.
- The gate summary states the meaning of green: pass summaries where
  classification ran end with `secretscan green = zero new secrets on changed
  lines`; zero-finding summaries are byte-identical to the previous format.
- Preflight's repo-wide secrets advisory (`preflight-service`) intentionally
  stays on total findings — it has no coder diff context and exists to
  surface pre-existing secrets.
