---
issue: 2838
---

## What changed

Post-merge review hardening for the `plan_cursor` feature (#2838), from a
full swarm-pr-review pass (4 base lanes + 11 risk-family micro lanes,
independent reviewer validation with live probes, and a 2-pass critic
challenge) plus external bot reviews and a Copilot review thread on the PR:

- The plan cursor is now sanitized: `extractPlanCursor` routes plan.md
  content through the shared `sanitizeContextText` at function entry, so
  `<system>`-style tags, `system:` directive lines, code-fence escapes, and
  invisible/BiDi characters in a user-writeable plan.md can no longer flow
  into the architect system prompt on either context path (or into the
  budget report's accounting, which now matches the sanitized text by
  construction). Benign markdown is unaffected (the sanitizer is
  idempotent and formatting-preserving).
- `resolvePlanCursorControls` no longer propagates `NaN` for non-numeric
  raw config values (which silently disabled the `max_tokens` upper-bound
  cap) — non-finite values fall back to the schema defaults — and `enabled`
  is coerced to a real boolean.
- Path B resolves the cursor controls before its plan.md read, so a
  disabled cursor never triggers the read.
- The `max_tokens` final cap now prefers cutting at a line boundary instead
  of slicing mid-line.
- Docs corrected again (README.md, docs/architecture.md): disabling the
  cursor keeps the phase header on the default path and the phase/task
  candidates on the scoring path — the earlier wording implied the default
  path also keeps a current-task injection, which it does not. The docs now
  also state that the compact rebuild reduces lookahead to one task.
- The #2580 release fragment gained its opening `---` frontmatter fence
  (consistency with sibling fragments; `combineFragments` concatenates
  verbatim).
- Wiring tests strengthened: exact lookahead counts (`- Next:` 0 vs 2),
  `estimateTokens(cursor) <= max_tokens` at the 500-token bound on both
  paths, and the missing Path-B disabled + valid-plan.json combination.

## Why

Follow-up to the #2838 review: 7 confirmed findings (3 medium, 4 low), all
reviewer-verified with file:line evidence and live probes; dispositions for
the rejected candidates are recorded in the review run
(.zcode/pr-review/pr2838-081adaf4/synthesis.md). The systemic class —
plan-derived phase/task one-liner injections that also bypass the sanitizer,
and BLOCKED phases silently dropped from the cursor — is tracked separately
in issue #2841.

## Verification

- `bun test tests/unit/hooks/plan-cursor.test.ts` (new resolver-hardening +
  sanitizer-hostile-content tests), `system-enhancer-plan-cursor-config-2580.test.ts`
  (strengthened wiring assertions), and the adjacent system-enhancer /
  context-budget suites — green.
- `bun run typecheck`, biome, trusted-root validator scan, registry-citation
  gate, FR-006/FR-011 ratchets, pending-fragment check — green.
