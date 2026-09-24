---
issue: 2926
title: "Attribution fallback silently reverts to repo-wide scope diff when the checking session differs from the recording session"
---

## What changed

The per-task attribution record that scopes the SCOPE WARNING (#2818 fix) is
session-keyed: writers record under the coder/parent session, the completion
gate reads under whichever session calls `update_task_status`. When those
sessions differed (multi-session swarms, restarts, snapshot misses, cap
eviction, workflow-complete release), the read came back empty and the gate
silently fell back to the repository-wide `git diff` — the exact cross-task
mis-attribution #2818 was filed for, for that subset of sessions, with no way
to tell the degraded mode from a legitimate legacy run.

Decided for #2926 (option 3, disclosure-first — the full option analysis and
decision record live in `docs/engineering-invariants.md`'s historical failure
map): the fallback itself stays, but it is never silent. `checkReviewerGateWithScope`
now appends a `SCOPE ADVISORY:` line to the gate reason on every in-session
scoped completion that did not use a per-task attribution record — including
completions where the repo-wide comparison was clean (previously
indistinguishable from an attribution-honored completion). A bounded,
fail-open probe of the other live sessions distinguishes:

- `SCOPE ADVISORY: attribution record for task <id> exists under another session — not used for scope verification`
- `SCOPE ADVISORY: no attribution record in this session — not used for scope verification`

The advisory is text-only: it never blocks completion, never changes which
files are compared, and never guesses a foreign session's record (options 1
and 2 were rejected-for-now with code-grounded reasons; see the decision
record). The existing SCOPE WARNING evidence clauses are byte-identical.

## Why

The #2917 review rounds dispositioned this as PRE-EXISTING +
design-decision-needed: the session-identity-mismatch trigger was not named
in that PR's disclosure, and operators had no signal that the per-task
guarantee had silently lapsed for a session subset.

## Notes

- New guardrail suite `tests/unit/hooks/attribution-session-contract-2926.test.ts`
  pins the full contract (mismatch/no-record/clean-set/empty-slot/cross-project/
  undefined-session/no-scope/missing-plan/malformed-entry/blocked-parity/
  placement-pin matrix).
- Honest limits (also in the failure-map entry): post-restart the probe sees
  only snapshot-restored records; attribution accuracy for the mismatch subset
  is unchanged by design; Epic-retained records can still surface a
  context-free foreign-session wording; the two plan reads per scoped
  no-record completion are racy against concurrent plan rewrites (bounded by
  pre-spawn evaluation; advisory-text-only consequence).
