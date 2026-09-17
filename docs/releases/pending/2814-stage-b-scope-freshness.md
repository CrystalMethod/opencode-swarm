---
issue: 2814
---

## fix(workflow): background Stage B verdicts no longer dropped by out-of-scope workspace activity

Closes #2814

Background `reviewer`/`test_engineer` completions were dropped as `stale` whenever ANY workspace
change landed between dispatch and completion — including commits and files belonging entirely to
OTHER tasks in the same session — because the Stage B freshness check compared whole-tree
`gitHead` + `dirtyHash` + `prHeadSha` and ignored the dispatch snapshot's declared review scope.
Clean, correctly-formatted verdicts (`[REVIEWED] | task-X | APPROVED | ...`,
`[TESTED] | task-X | PASS | ...`) were never recorded: `check_gate_status` reported
`passed_gates: []`, `update_task_status(completed)` failed with `Missing gates: [reviewer,
test_engineer]`, and the task wedged at `pre_check_passed` with no recovery path (the dropped
record retried forever against an immutable dispatch snapshot; `/swarm recover` only repairs
`coder_delegated` and `recover_rework_task` only handles `rework_required`).

**What changed**: `compareStageBWorkspace` (`src/background/stage-b-gates.ts`) now narrows the
freshness check for non-docs gate roles to the dispatch snapshot's declared review scope. The
project-root and PR-head identity legs are unchanged; the tree-state legs become (a) no declared
scope file appears in the committed diff between the dispatch and current heads, and (b) the set
of dirty/untracked scope files is identical between the two snapshots. Concurrent activity on
other tasks' files no longer invalidates a verdict; every form of in-scope drift (newly dirty,
committed during the run, or dirtied at dispatch and reverted) still does, with scoped stale
reasons (`in-scope committed change: ...`, `in-scope dirty set changed: ...`). When no scope file
can be derived from the stored scope string (bare task id / null), or either snapshot is
capture-degraded (null `gitHead`/`changedFiles`), the previous whole-tree comparison applies —
the narrowing never admits more than before. New bounded helper `committedFilesBetween`
(`src/background/workspace-snapshot.ts`) supplies the committed-diff leg through the existing
bounded git runner.

**Recovery note for tasks wedged before upgrading**: records already marked `stale` by the old
behavior do not auto-recover (the ingestion claim only re-claims `completed`/`ingestion_error`
records, and maintenance sweeps stale records). After upgrading, re-dispatch the Stage B gates
for the affected task — a fresh Task call records correctly under concurrent activity. Avoid
reusing the previous dispatch's session id.

**Adjacent gaps confirmed separately (not fixed here)**:

- Foreground Stage B settlement silently drops settlements on unbound launch generation, route
  receipt blocks, and evidence-throw catches (`src/hooks/delegation-gate.ts:6301-6305`,
  `:6416-6421`, `:6472-6477`) — same defect family, different path; filed as a follow-up.
- The cross-task `SCOPE WARNING` mis-attribution (`src/hooks/diff-scope.ts:96-97` derives changed
  files from the repository's latest commit regardless of which task is being checked) still
  emits its mis-attributed warning after this fix; filed as a follow-up.
