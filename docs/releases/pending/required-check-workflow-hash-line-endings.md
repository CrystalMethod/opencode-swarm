# Required-check workflow hash is line-ending independent

## What

`scripts/check-required-check-contract.ts` now normalizes CRLF before hashing a
contract-owned workflow, so the recorded `localWorkflowHashes` values describe the
committed content rather than a checkout's line-ending translation.

## Why

The evidence file records one sha256 per contract-owned workflow, and the checker compares
it against the file on disk. Two of the three workflows (`ci.yml`, `drift-check.yml`) are
committed with CRLF, so a `core.autocrlf=true` Windows checkout serves them byte-identical
to the Linux runner and they match. `pr-standards.yml` is committed LF: the same checkout
serves it CRLF, so its hash never matched — a Windows contributor sees
`WORKFLOW_CHANGED_AFTER_CAPTURE` as a blocking `drift` error on an entirely unchanged
tree. That is the inverse of the failure the capture refresh fixed: CI green, local red,
with no way to tell a real workflow edit from a line-ending artifact.

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