---
issue: 2955
---

# One shared path-class table for every release-fragment gate

## What changed

The two required release-fragment gates no longer disagree. The "does this PR need a `docs/releases/pending/` fragment?" verdict is now single-sourced in one declarative path-class table (`scripts/user-visible-paths.ts`), and every gate consumer reads it:

- `scripts/check-pending-fragment.ts` re-exports the table's classifiers (behavior unchanged for the quality gate) and gains a machine-readable `--print-requirement` mode (changed paths on stdin, `--added` flags for the added list, prints `required=<bool> satisfied=<bool>`, exit 0/1/2).
- The `pr-standards` workflow's pull_request and dispatched arms, and the `release-and-publish` cleanup self-check, dropped their hand-maintained bash path regexes and now pipe their changed/added lists into the shared classifier (pinned `setup-bun`/`checkout` steps added, conditioned off `merge_group`).

## Why

The TS gate and the triplicated bash regex implemented the same AGENTS.md mandate with contradictory predicates: 9 path classes got opposite verdicts from the two required checks (scripts/tests/test/examples/bun.lock/bunfig PRs were falsely blocked by PR Standards; workflow/skills/docs-configuration PRs were only blocked by quality), and a modify-only pending fragment satisfied one gate but not the other. Resolution: the TS classification wins everywhere (per-class rationale recorded in the table), satisfaction is added-only, and re-introduction of a hand-maintained predicate now fails both a parity/ratchet test (`tests/unit/scripts/user-visible-paths-parity.test.ts`) and a new `fragment-path-parity` drift-check detector (per-site anchor counts). Also ships the missing `CONTRACT_BUCKET_DEMOTION` killing test (the audit's MUT-1) in `tests/unit/scripts/required-check-contract-2677.test.ts`, with a fixture isolated to the `:427` baseline arm the existing wiring test's OR-shaped assertion could not pin.

## Contributor-visible effects

- scripts/tests/examples-only PRs no longer require a release fragment (they never ship to users — `scripts/` is not in the npm package).
- `.github/workflows/`, skills-tree, and `docs/configuration.md` PRs now require a fragment from BOTH gates consistently.
- A PR that only **modifies** an existing pending fragment no longer satisfies the fragment gate (satisfaction is added-only), so a user-visible PR must add its own fragment rather than editing another PR's pending file.
- The required-check evidence file's `localWorkflowHashes` pin for `pr-standards.yml` was refreshed for the workflow edit (one line).

## Verification

Frozen acceptance checks C1-C7 (issue-trace 2955-fragment-path-table) RED→GREEN at the PR head; parity matrix (22 rows: 9 divergent classes, 3 agree rows, 10 behavior/coverage rows) plus a table-shape guard for the four never-prefix rows, regex ratchet, AMR/A semantics, detector fixtures (re-introduction, single-arm reversion, trimmed-fork notice, bare-flag non-anchor), and the MUT-1 red/green mutation demo all pinned by test; `bun run drift:check --enforce` and `bun run check:invariants` green.
