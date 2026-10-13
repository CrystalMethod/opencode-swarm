# Step 7 closeout playbook

### Conflict closeout

After resolving merge conflicts or syncing a stale branch:

1. verify there are no local unmerged paths or conflict markers,
2. push the conflict-resolution commit,
3. verify GitHub reports both `mergeable: MERGEABLE` and
   `mergeStateStatus: CLEAN`, not merely that local markers are gone, and
4. keep a conflict/branch-drift item in the PR closure ledger when it affected
   the PR.

If GitHub still reports `DIRTY`, `BLOCKED`, or stale checks after local conflict
resolution, fetch current `origin/main` again and re-evaluate before claiming the
conflict is resolved.

### GitHub auto-merge race condition

With a merge queue enabled, prefer queuing over manual freshness rebases. If you encounter "fetch first" errors after a fresh fetch, GitHub may have auto-pushed a merge commit. Recovery: force-push your local commit with `--force-with-lease`. See `references/pr-incident-playbook.md` for full diagnosis and recovery steps.

### Check closeout

`gh pr checks --watch --fail-fast` is useful but can lag or flatten matrix and
downstream jobs. When the PR checks view looks stale, missing, or inconsistent,
use the workflow run as the authoritative detail:

> **MCP environments:** When using GitHub MCP tools instead of `gh`, prefer
> `get_check_runs` over `get_status`. The `get_status` method uses GitHub's
> legacy commit status API: it returns `state: "pending"` even when all GitHub
> Actions jobs are green, because Actions creates check-runs (not legacy
> statuses). `get_check_runs` returns the actual job results.

```powershell
gh run view <run-id> --json headSha,status,conclusion,jobs,url
```

Keep watching after unit jobs pass; this repository may enqueue integration and
smoke jobs later in the same CI run. Do not call the PR green until the current
`headRefOid` has all required jobs completed successfully.

If a previous run from an older PR head is still in progress or already failed
and is blocking the current head's workflow through concurrency, inspect it with
`gh run view <run-id> --json headSha,status,conclusion,jobs,url`. Cancel only
obsolete older-head runs that are no longer relevant to the PR head you are
validating, then wait for the current-head checks to complete.

If you edit the PR body after checks are green, expect PR Standards / title
checks to rerun. Re-check before claiming final green or merge-readiness.

### Merge queue (current-base validation)

Read `file:.swarm/bundled-skills/merge-queue-readiness/SKILL.md` for the full pre-queue merge-group CI simulation protocol.

When `main` has a GitHub **merge queue** enabled, do not rebase or force-push a PR
*solely because `main` advanced*. Once required checks and review are green, add the
PR to the merge queue; GitHub re-runs the required workflows against the queued
change on top of the latest `main` (and any earlier queued PRs) before merging, so
manual "freshness" rebases are unnecessary.

Still rebase/force-push when there is a **real** reason: a genuine merge conflict,
a stale review thread that depends on current SHAs, or a correctness issue that only
appears against current `main`. The queue handles up-to-date validation; it does not
resolve conflicts for you.

Required workflows trigger on both `pull_request` and `merge_group`. PR-only checks
(title/body validation) no-op to success on `merge_group` because the PR already
satisfied them before being queued.
