---
type: fix
issue: 3199
---

## PR-review observability journals no longer advance the durable gate revision

The PR-review rejection journals (`prReviewSubmitRejections`, written when a
lane child's `submit_pr_review_result` is rejected; `prReviewVerdictRejections`,
written when the gate owner's `write_pr_review_artifact` is rejected) and the
skill-contract advisory list are observability-only data, but they were
persisted through the same CAS-checked write path the state machine uses for
real transitions — so every journaled rejection bumped the durable gate
`revision` and could trip a concurrent gate operation's read-check-write CAS
(`complete_pr_workflow`'s terminal-readiness compare, the terminal-clear
compare, or the write CAS itself) with a spurious
`BLOCKED: ... state changed ...` failure. Because same-session tool calls can
run as parallel tool parts, a journaled rejection landing inside another
operation's window invalidated it (#3199).

Journal and advisory writes now go through a dedicated non-transitioning
append that keeps the state-machine revision (and the coordination row's
generation) in place while still CAS-writing the row atomically, and every
state-machine write preserves the observability fields from the durable state
(a stale snapshot can neither clobber appended entries nor resurrect cleared
ones). The revision CAS still rejects genuine concurrent state mutations.

Behavior note: the auto-resume wake brake's progress token hashes the gate
revision, so a journal-only write no longer counts as "wake progress" — a
failure loop that only journals rejections now correctly accrues unproductive
wakes (previously each journal write reset the counter). Real controller
activity (actual state writes, lane transitions, receipt digests) still
counts as progress.
