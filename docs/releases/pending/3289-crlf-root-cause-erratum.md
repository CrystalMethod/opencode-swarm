---
issue: 3289
---

# Correction: the required-check workflow hash fix is line-ending independent — and all three workflows are committed LF

## What

This corrects the mechanism paragraph of "Required-check workflow hash is
line-ending independent" in the v7.195.0 notes. That release is already
published and its body is immutable, so the correction ships as this erratum
rather than an edit. The corrected fact: **all three** contract-owned workflows
(`ci.yml`, `drift-check.yml`, `pr-standards.yml`) are committed with LF-only
blobs — none of them is committed with CRLF.

## Why

The published section said two of the three workflows (`ci.yml`,
`drift-check.yml`) are committed with CRLF while `pr-standards.yml` is
committed LF, producing a two-match/one-mismatch hash split under
`core.autocrlf=true`. Execution disproves that story: every revision of all
three workflow blobs in HEAD-reachable history carries zero CR bytes,
`.gitattributes` has carried `* text=auto eol=lf` since the rule was
introduced — its earliest form carried a UTF-8 BOM on the first line, which
could disable the rule for checkouts of that historical state until the
2026-09-07 correction ("fix(git): restore LF checkout attributes"; see the
v7.169.0 notes) — and all three recorded `localWorkflowHashes` equal the LF
blob hashes. The verified
mechanism is checkout-side: the pre-fix `sha256()` in
`scripts/check-required-check-contract.ts` hashed working-tree bytes, so a
Windows checkout carrying CRLF working copies mismatched the recorded LF-blob
hash on an entirely unchanged tree. Which files on a given checkout carry CRLF
— and the contributor-side configuration that produced them — is checkout state
the repository cannot reconstruct; the `core.autocrlf=true` example is
execution-refuted (a fresh clone with it is served LF). The fix, its fixture
pin, and its behavior change are unchanged: `WORKFLOW_CHANGED_AFTER_CAPTURE` no
longer fires for an unchanged LF-stored workflow in a CRLF checkout, and a real
content change still fails closed on every platform.
