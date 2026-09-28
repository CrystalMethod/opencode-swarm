---
issue: 2902
---

# Host-contract drift check against npm-latest host source

## What

The OpenCode host's message→request converter — the code the #2526
guidance-carrier contract depends on — is now checked against the REAL host
source at the version users actually install, not just against this repo's
lockfile pin. Previously the only tripwires asserted that
`@opencode-ai/plugin`/`@opencode-ai/sdk` resolved at the pinned version, so a
host release that changed the converter structure would have landed silently
until a user reported missing guidance.

New pieces:

- `scripts/check-host-contract.ts` — resolves the host tag from npm-latest
  (or an explicit `--tag`; `--source <path>` runs offline against a local
  file), fetches `packages/opencode/src/session/message-v2.ts` from the host
  repo with a bounded timeout, extracts the `toModelMessagesEffect` converter
  loop with the TypeScript AST, and compares its structural statement list
  (parts-length guard, the two role branches, absence of a role-split `else`)
  against a committed corpus. Verdicts are two independent axes: structural
  drift fails the run with a unified diff naming the changed statements;
  textual-only drift (new in-branch handling, reformatting) exits 0 with a
  notice recommending a corpus refresh. A moved/renamed host file is a
  failure (`result=SOURCE_NOT_FOUND`), never a silent pass. On drift, a
  single deduplicated tracking issue (`Host contract drift: message-v2.ts @
  <tag>`) is opened or updated via `gh`.
- `.github/workflows/host-contract-check.yml` — a weekly scheduled
  (Monday 13:00 UTC) blocking run plus `workflow_dispatch`, and a
  PR-time advisory lane gated on changes to `tests/helpers/host-*`,
  `tests/fixtures/host/**`, the check script, the workflow, `bun.lock`, or
  `package.json`. The compared tag and digest land in the job summary.
- `tests/fixtures/host/` — verbatim converter excerpts from host v1.18.3
  (the pinned version) and v1.18.33 (npm-latest at implementation time), a
  structural mutant with a role-split `else`, a no-loop fixture, and the
  generated `expected-structure.json` corpus.
- Unit suites for the extractor/digest (including synthetic in-test
  mutations: dropped parts guard, renamed role literal, intra-branch `else`
  staying textual, comment/whitespace rewrites staying stable), tag
  resolution, and routing dedupe with `gh` mocked.

`AGENTS.md` invariant 10 and the fixture's provenance header now name the new
trigger: re-verify the fixture on a lockfile bump OR a host release; the
weekly scheduled check is the trigger.

## Why

Frontier-audit finding D4 (Workstream I, slot I5): the repo's
host-contract tripwires were keyed only to lockfile events, while the actual
risk event is a host release. At implementation time npm-latest was 1.18.33
against the pinned 1.18.3 — thirty releases of drift with zero signal
anywhere, and the live converter loop still happens to be structurally
unchanged (verified: the loop is byte-identical across v1.18.3 → v1.18.33;
the textual differences live elsewhere in the converter function, which the
advisory axis now surfaces).

## Verification

- Live: `bun scripts/check-host-contract.ts` (npm-latest) and
  `--tag v1.18.33` both exit 0 with `result=STRUCTURE_MATCH` (plus the
  textual-drift notice); the role-split-else mutant exits 1 with a diff
  naming the added `else`; the no-loop fixture exits 1 with
  `result=SOURCE_NOT_FOUND`.
- `bun test tests/unit/scripts/check-host-contract-2902.test.ts
  tests/unit/scripts/ci/host-contract-check-workflow-2902.test.ts` — 24 tests
  green.
