---
issue: 2946
---

/swarm rollback: destructive restores now require a confirm token and back up what they destroy

`/swarm rollback` used to be the one destructive command in the swarm surface with no preview, no confirmation, and no backup: restoring a git checkpoint ran `git reset --hard` immediately — silently discarding any uncommitted tracked work — and the legacy phase path wholesale-overwrote live `.swarm/` state, leaving no copy of the bytes it replaced. The `checkpoint` tool's restore action had the same ungated sink and is reachable by agents, not just humans.

Rollback now adopts the same two-step contract as `/swarm close` and `/swarm reset-session`:

- **Preview first.** When a restore would actually destroy work (uncommitted tracked changes on the git path, or live `.swarm/` state that a phase checkpoint would overwrite), the first invocation prints exactly what would be destroyed and stops. Nothing is reset.
- **Confirm token.** The preview issues a 15-minute, single-use `--confirm=<token>` bound to the exact destruction scope. If the tree changes between preview and confirm, the token is refused with a scope-changed message — re-run the preview for a fresh token.
- **`--yes` escape hatch.** `--yes` confirms in one invocation for automation, through the same token machinery (still scope-bound), never around it.
- **Automatic backup.** Every executing restore copies the bytes it is about to destroy into `.swarm/rollback-backups/<timestamp>/` (newest 5 kept) — dirty tracked files under `tracked/`, and prior live `.swarm/` state on the legacy path — so a confirmed rollback is recoverable by copying files back.
- **Clean trees unchanged.** Restoring with a clean tracked tree and no differing live state stays a single call, exactly as before.
- **Fail-closed verification.** If the working tree cannot be verified (git status unreadable in a real repository), the restore refuses instead of assuming the tree is clean.

The same gate now covers every surface that can trigger the restore: `/swarm rollback`, `/swarm checkpoint restore`, and the agent-reachable `checkpoint` tool (which returns the preview plus token instead of resetting when the scope is destructive).

To keep this class of gap from reappearing, `bun run check:invariants` grows a new Check 9: every command in the registry whose key, description, or details matches the destructive vocabulary must either adopt the shared two-step primitive (or a validated equivalent token contract) or carry a justified `key | owner | reason` entry in `scripts/destructive-command-exceptions.txt`. The enumeration is name-pinned, so a destructive command cannot be reworded out of the set, and the exception list is non-growing — stale lines are themselves violations. `/swarm reset` is the seed exception (its legacy `--confirm` + auto-backup contract predates the primitive; migration is tracked in the Workstream J epic).
