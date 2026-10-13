---
title: "Skill contract addendum — closure reconciliation, named-mutation discipline, probe hygiene"
---

## What

The four contract skills (`issue-tracer`, `swarm-pr-feedback`, `swarm-pr-review`,
`commit-pr`) gain a `## Contract addendum (2026-10-12)` section, distilled from a
post-merge audit of ZaxbyHub/ragappv3 PR #708/#883 where two closure dispositions
were recorded as FIXED while the obligation had silently changed shape, and four-plus
mutants survived the entire frozen gate suite:

- **issue-tracer**: every DISCRIMINATING check must name one mutation it kills
  (recorded in its 08 block); frozen-file docstrings must read "RED at base, GREEN
  after the fix"; write `repro/replay-all.sh` at freeze time so replays cannot drop
  `--copy`; closure is a reconciliation against the PUBLISHED artifacts with stable
  obligation identity and explicit deferment authority for partial closure.
- **swarm-pr-feedback**: grep the live PR body against every body-fix ledger row
  before the reviewer gate; probes must restore and leave `git status --porcelain`
  clean (an uncommitted mutant survived a merge); no obligation substitution between
  ledger and proof, with a two-directional coverage-diff before implementing.
- **swarm-pr-review**: candidate rows are defect claims only — verification notes
  and INFO-severity rows belong in the lane attestation.
- **commit-pr**: re-derive body claims (PR head SHA, test counts, file lists) from
  the final tree as the last step before publish.

## Why

Every rule above traces to a failure this audit actually caught rather than a
hypothetical: a ledger that says FIXED is a promise reviewers and future traces
rely on, so it must be grep-verifiable against the artifact it claims; a check that
cannot name a mutation that kills it has never been shown to bite; and probe
residue in a shared worktree is one `git add -A` away from shipping a mutant.

## Known limitations

- The rules are contract text: `trace-check.sh` does not yet mechanically enforce
  the named-mutation row or the closure-reconciliation checklist (the acceptance
  table keeps its ten-column shape), so reviewer/critic judgment carries them for
  now.
- Local `.swarm/bundled-skills` vendoring and the ZCode user-level copies were
  updated in place in the same session but are untracked by design.
