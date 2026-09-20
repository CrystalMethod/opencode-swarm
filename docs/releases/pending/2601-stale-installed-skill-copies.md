# PR-workflow MODE entry can no longer load a stale installed skill copy silently

Issue #2601.

## What

- MODE gate activation (`activatePrWorkflow`) now verifies the mode's stamped skill
  (`swarm-pr-review` / `swarm-pr-feedback`) against the shipped package source: a
  stale or missing `.swarm/bundled-skills/<slug>/SKILL.md` is healed by a bounded
  re-run of the existing bundled-skill sync, and a `skillContractAdvisories` record
  naming BOTH the stale path and the canonical source is persisted on the durable
  gate state and surfaced through `advisoryWarn`. Detection never blocks activation
  (fail-open by design).
- The auto-resume wake path (`session.idle` → continuation prompt) — the entry that
  previously bypassed both the init-time (fail-open, may predate a plugin update)
  and command-path syncs — now runs the same verification: a stale copy is healed
  by the bounded re-sync, a copy that went MISSING after activation is
  re-materialized within the wake budget, and an unrestorable missing copy lands
  an actionable advisory naming the missing path and the canonical source (the
  architect's MODE stub references that exact private path). Wake-detected
  advisories are appended to the durable state
  (`appendPrWorkflowSkillContractAdvisories`, CAS-writer-serialized, deduped,
  capped) and surfaced as a bounded `[skill-contract advisory]` block
  (max 4 × 500 chars, only on detection) in the continuation prompt so the
  architect that would load the stale copy sees the named paths and the
  executable repair. A clean host leaves the prompt byte-identical to the
  previous text.
- Stale user-global copies (`~/.opencode/skills/<slug>`, `~/.claude/skills/<slug>`)
  are detected at the same points and reported with the delete-the-stale-copy
  repair — read-only, mirroring the #2859 drift-check detector's invariant.
- The digest primitives (`splitSkillFrontmatter`, `skillContractDigest`,
  `SKILL_CONTRACT_DIGEST_KEY`, `readSkillContractStamp`) moved to a shared src
  module (`src/config/skill-contract-digest.ts`); `scripts/drift-check.ts`
  re-exports them so existing consumers are unchanged.
- drift-check gained `bundled-skill-staleness`: the `.swarm/bundled-skills`
  installed copies of the stamped skills are compared against the repo canonical;
  a stale copy is a WARNING (blocking under `--enforce` on developer machines),
  an absent surface stays silent (CI checkouts have no `.swarm/`).

## Why

A stale installed copy of `swarm-pr-review` (user-global or bundled) prescribes the
recovery ladder the active gate mechanically blocks and can predate the verdict
vocabulary bridge, so a correctly-behaving architect was routed into
abort-or-INCOMPLETE with no error attributing the failure to the stale copy — the
proximate cause of the two observed failed PR-review runs on this host (#2601's
DD-C012/DD-C014; see also the #2859 post-mortem). #2863 shipped the marker and the
dev-time user-global detector; the runtime half and the bundled dev-time surface
are this change.

## Verification

- Frozen issue-tracer acceptance checks C1-C4 (activation advisory, activation
  heal, drift-check bundled-surface finding, real `session.idle` wake drive) all
  RED at base `d9688a7d9` and GREEN at the fix; C5 (audience fail-closed
  preservation) GREEN at both.
- New suites: `tests/unit/services/pr-workflow-skill-contract-2601.test.ts`,
  `tests/unit/hooks/pr-workflow-gate-skill-contract-activation-2601.test.ts`,
  `tests/unit/hooks/pr-workflow-response-gate-wake-sync-2601.test.ts`,
  `tests/unit/scripts/drift-check-bundled-skill-staleness-2601.test.ts`
  (including the stamped-frontmatter digest pin and the wake-path recorded arm).
