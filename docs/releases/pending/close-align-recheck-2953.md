---
issue: 2953
---

## What

`/swarm close` (finalize) now re-verifies the tracked-dirty tree immediately
before its destructive `git reset --hard` alignment step. Previously the
destructive-purge gate measured the tree exactly once at the top of the
command; any tracked file written after that measurement — by a background
delegation subagent, a second session in the same worktree, or an IDE
auto-save — was destroyed by the alignment reset without ever being previewed
or confirmed, and typically without any warning (the shipped "changes
discarded" signal is derived after the reset, when the tracked work is already
gone).

## Fix

The measurement the operator confirmed (or the empty clean-tree set) is
carried through the close pipeline and re-verified with the same parser inside
the alignment dispatch — a fail-closed guard installed on the
`resetToMainAfterMerge` seam at wiring time. If the tracked-dirty set grew
since the gate measurement, or the status cannot be re-read at all, the
alignment aborts: nothing is reset or checked out, finalize/archive/clean have
already completed and are preserved, and the close output carries a bounded
refusal naming the newly-dirty files (first 10 plus an overflow count).
Complete git alignment manually if still wanted. The porcelain parse is now a
single shared export (`parseTrackedDirtyPaths` in `src/commands/destructive-purge.ts`)
consumed by both the gate and the re-check, hardened to recognize rename/copy
records with R/C in either status column.

## Caveats

- Worktree-only renames (`git add -N` style, ` R old -> new`) previously
  appeared in the destructive-close preview as ONE garbled `old -> new` entry;
  they now correctly list both sides. The preview count and the confirm-token
  scope digest change for such trees, so a token minted before this upgrade is
  rejected after it with the shipped "purge scope changed" refusal — fail
  closed, by design.
- A small residual window remains between the guard's re-measurement and the
  actual reset (the `git fetch --prune` and default-branch checkout inside the
  shared `resetToMainAfterMerge`). Closing it requires re-checking inside
  `src/git/branch.ts`, which this change deliberately does not touch; tracked
  as follow-up material.
- If a changed path at re-check time sits under `.swarm/`, the refusal names
  it and suggests the untrack remediation (`git rm -r --cached .swarm/`):
  close never treats runtime state as confirmed destructive scope, and the
  plugin normally git-excludes `.swarm/` at init — seeing it here almost
  always means runtime state was `git add`-ed by hand.
- Same-path content drift (a file that was already confirmed dirty gets
  written again in-window) is still discarded — the confirmed scope is a SET of
  paths, per the #2508 two-step contract.

## Tests

`tests/unit/commands/close-align-recheck-t1c2.test.ts`: both audit
reproduction arms (clean-tree fast path; confirmed close with a
never-previewed file) now abort the alignment with the in-window bytes
surviving verbatim; a 10-iteration deterministic loop; a no-drift control
pinning current behavior; the unreadable-status fail-closed path; bare
`.git`-marker roots unaffected; refusal bounds (10 listed + overflow); and a
parser battery including a real `git add -N` worktree rename.
