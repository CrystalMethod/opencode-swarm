# Required-check workflow hash is line-ending independent

## What

`scripts/check-required-check-contract.ts` now normalizes CRLF before hashing a
contract-owned workflow, so the recorded `localWorkflowHashes` values describe the
committed content rather than a checkout's line-ending translation.

## Why

The evidence file records one sha256 per contract-owned workflow, and the checker compares
it against the file on disk. Before this change the checker hashed the working-tree bytes
exactly as they were, while the recorded hashes describe the committed content: all three
contract-owned workflows (`ci.yml`, `drift-check.yml`, `pr-standards.yml`) carry LF-only
blobs — zero CR bytes — and `.gitattributes` carries `* text=auto eol=lf`, so each recorded
hash is the sha256 of the committed LF content. A Windows checkout whose working copies
carry CRLF bytes therefore mismatched the recorded hash on an entirely unchanged tree: a
Windows contributor saw `WORKFLOW_CHANGED_AFTER_CAPTURE` as a `drift` error while CI
stayed green (its Linux runners hash the same LF bytes), with no way to tell a real
workflow edit from a line-ending artifact. Which files on any given checkout carry CRLF,
and the contributor-side configuration that produced them, is checkout state the
repository cannot reconstruct; what the repository proves is that the committed blobs are
LF, that the recorded hashes describe that LF content, and that the mismatch followed the
working copy, not the committed file.

## Change

One line in `sha256()` plus its pin. `tests/unit/scripts/required-check-contract-evidence-2677.test.ts`
gains a fixture that commits the three workflows as LF, rewrites the working copy as CRLF
exactly the way `core.autocrlf=true` does, and asserts the finding is absent; the same
test then re-tampers a recorded hash and asserts `WORKFLOW_CHANGED_AFTER_CAPTURE` still
fires, so a genuine workflow change fails closed on every platform.

## Behavior change

`WORKFLOW_CHANGED_AFTER_CAPTURE` no longer fires for an unchanged LF-stored workflow in a
CRLF checkout. A real content change still fires everywhere.

## Migration

None. `docs/ci/required-check-evidence.json` is unchanged — its recorded hashes already
describe the committed blobs.