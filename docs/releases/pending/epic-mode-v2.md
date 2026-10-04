# Epic Mode v2

## What changed

- **Epic completion markers are plan-scoped.** Rule 2's `swarm(task <id>):` marker commit now ends with a `Swarm-Plan: <planKey>` trailer (`planKey = sha256(planIdentityHash + '|' + planEpoch).slice(0, 16)`). Rule 2's idempotency check and Rule 3's predecessor evidence (`epic_plan_waves`, `epic_decide_phase`) honor a marker only when it belongs to the current plan — its trailer matches the current plan key, or it is a legacy marker without a trailer committed at/after the plan root (the earliest plan-ledger event). Each read is a single bounded `git log` (marker `--grep`, `--max-count`); the plan-root check runs per commit rather than via `git log --since`, so an older-dated commit (clock skew, rebased history) cannot hide newer markers.
- **Stale worktree merge failures no longer suppress Rule 2.** The shared `.swarm/worktree-merge-status.json` registry is keyed by bare task id and never cleaned. Epic now ignores a failure recorded before the current plan's root; a failure with no timestamp is still treated as relevant (fail closed). `/swarm epic status` lists recorded merge failures as blocking, undated, or stale, with the remedy. New `/swarm epic clear-merge-failure <taskId> [--confirm]` clears a recorded failure that no longer reflects reality (for example an undated record from a cancelled task); without `--confirm` it only previews.

## Why

Task ids repeat across plans (every plan has a `1.1`). Before this change, a previous plan's `swarm(task 1.1):` marker made the current plan's 1.1 an idempotent skip — its work was never committed — and falsely satisfied Rule 3 for dependants. A merge failure recorded for a previous plan's `1.1` also suppressed the current plan's Rule 2 marker indefinitely.

## Migration steps

- None required. Markers written before this release have no trailer; they still count for the plan in progress if they were committed at/after its plan root. Markers from earlier plans no longer count.
- To commit a task's changes manually as Rule 2 evidence, end the commit message with the `Swarm-Plan: <planKey>` trailer that the `scope-unresolved` warning prints.

## Known caveats

- A plan whose identity cannot be resolved (for example conflicting plan-epoch metadata in the ledger) gets no Rule 2 marker, and Rule 3 fails closed for it (dependants are serialized/demoted) until the ledger is repaired.
- Plan-ledger re-roots: re-rooting the plan ledger — a `save_plan` that renames the plan's title or swarm, `/swarm rollback`, or a truncated-ledger recovery — mints a new plan root and plan key. Markers committed before the re-root are orphaned (Rule 3 no longer counts them, so dependants serialize until re-completed: fail closed), and a worktree merge failure recorded before the re-root is treated as stale, so Rule 2 writes the marker even though that merge never landed (fail open). Check `/swarm epic status` and `/swarm lanes` after such a re-root. Later Epic v2 commits replace the plan root with Epic-owned identity and wave timestamps.
