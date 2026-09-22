# Scope warning attribution (update_task_status)

## Fixed

- The `SCOPE WARNING` emitted by `update_task_status` no longer attributes the repository's latest commit to whichever task is being checked (#2818). `validateDiffScope` now sources the changed-file set from the calling session's task-keyed attribution record (`modifiedFilesByTask`) when it has one for the checked task, so a concurrent task's latest commit no longer triggers a warning naming the other task's files. When no attribution record is available (legacy sessions, CLI-direct runs, records released at workflow-complete, or entries evicted at the bounded 128-task cap), the previous repository-wide comparison is kept and the warning now names its evidence — the diff basis and the latest commit short SHA — so possible mis-attribution is visible instead of silent.

## Notes

- The warning remains advisory-only: it never blocks the completion gate.
- `scope-persistence.ts` authority-layer reads never used a git diff and are unaffected.
