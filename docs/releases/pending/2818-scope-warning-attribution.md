---
issue: 2818
---

# Scope warning attribution (update_task_status)

## Fixed

- The `SCOPE WARNING` emitted by `update_task_status` no longer attributes the repository's latest commit to whichever task is being checked (#2818). `validateDiffScope` now sources the changed-file set from the calling session's task-keyed attribution record (`modifiedFilesByTask`) when it has one for the checked task, so a concurrent task's latest commit no longer triggers a warning naming the other task's files. Attribution entries are canonicalized against the workspace before comparison (absolute, `..`-bearing, and — on Windows — case-mismatched entries resolve or drop instead of false-warning the task's own in-scope work, and absolute `.swarm/` entries stay filtered). When no attribution record is available (legacy sessions, CLI-direct runs, records released at workflow-complete, or entries evicted at the bounded 128-task cap), the previous repository-wide comparison is kept and the warning now names its evidence — the diff basis and the latest commit short SHA — so possible mis-attribution is visible instead of silent.

## Notes

- The warning remains advisory-only: it never blocks the completion gate.
- Once a task has an attribution record, files changed only via shell side-effects (formatters, codegen, `git checkout`) are no longer seen by this after-the-fact advisory check: attribution is recorded for direct-write tools only (shell writes are enforced pre-execution by the shell-write gate when enforcement is enabled). See #2927 for the coverage-contract decision.
- Raw tool-arg paths are still recorded un-normalized at the write site; `validateDiffScope` canonicalizes at read time, and normalizing at the write site (fixing it for every consumer of the attribution record) is tracked in #2925.
- `scope-persistence.ts` authority-layer reads never used a git diff and are unaffected.
