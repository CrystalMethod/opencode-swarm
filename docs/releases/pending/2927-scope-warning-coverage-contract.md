---
issue: 2927
---

# Scope-warning coverage contract decided for shell side-effects (Option 1)

## What changed

- The coverage contract for the advisory `SCOPE WARNING` under per-task
  attribution is now DECIDED (issue #2927, Option 1: accept + keep
  documented) and recorded as a standing entry in
  `docs/engineering-invariants.md` — previously the boundary existed only in
  the #2818 release fragment's disclosure (shipped via PR #2917) and code
  docstrings.
- Added `tests/unit/hooks/shell-side-effect-attribution-boundary-2927.test.ts`,
  which pins the decided boundary so it cannot drift silently: the consumer
  legs (attribution present — a formatter/codegen-style shell side-effect
  file is invisible to the advisory check by design; attribution absent or
  empty — the legacy repository-wide leg still flags it, naming its
  evidence), the `WRITE_TOOL_NAMES` shell exclusion, a behavioral producer
  pin (an in-scope bash write under an active coder delegation records NO
  attribution while a direct write does), and a hardened wiring pin over the
  shell-write region of `tool-before.ts`.

## Notes

- No behavior changed. The decision ratifies the post-#2818 semantics: the
  after-the-fact advisory check is a direct-write attribution check on
  foreground paths; shell coverage on those paths is pre-execution
  shell-write enforcement (the coder default — observe mode and
  scope-lenient roles have no after-the-fact coverage for such changes,
  a gap the invariant entry records as disclosed and accepted). Background
  settlement attribution is git-derived and still sees shell side-effects —
  the
  foreground/background producer distinction is spelled out in the new doc
  entry.
- Revisit trigger: operator reports of formatter/codegen drift escaping
  review on foreground paths. A revisit landing on Option 2 (task-windowed
  git diff union) or Option 3 (recording shell writes into attribution) is a
  behavior change that must reopen the invariant docs and supersede the
  decision entry; the trade-offs of both are recorded there.
- Non-goals, tracked separately: #2925 (normalize attribution paths at the
  write site) and #2926 (attribution fallback when the checking session
  differs from the recording session).
