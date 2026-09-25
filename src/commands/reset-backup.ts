import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';

/**
 * Result of an auto-backup taken before a destructive /swarm reset or
 * /swarm reset-session. Fail-open by contract: any per-entry failure is
 * recorded as a warning and never thrown.
 */
export interface ResetBackupResult {
	/** Absolute path of the backup directory, or null if nothing was backed up. */
	backupDir: string | null;
	/** Relative names actually copied into the backup. */
	copied: string[];
	/** Non-fatal warnings (source unreadable, prune failure, etc.). */
	warnings: string[];
}

/** How many backup directories to retain under .swarm/reset-backups/. */
export const RESET_BACKUP_RETENTION = 5;

/** Which `.swarm/` subdirectory a backup family lands under (#2946). */
export type ResetBackupsRoot = 'reset-backups' | 'rollback-backups';

/**
 * Copy the swarm-state entries a reset is about to delete into a durable,
 * timestamped directory under `.swarm/reset-backups/` (or
 * `.swarm/rollback-backups/` for rollback restores, #2946) BEFORE deletion,
 * so the user can recover by copying the files back. The backup directory is
 * not part of any reset deletion set, so it survives the reset.
 *
 * This deliberately does NOT use the git checkpoint tool: that tool excludes
 * `.swarm/` (`git add ... :!.swarm/`) — i.e. it excludes exactly the state a
 * reset destroys — and would commit unrelated working-tree changes to the
 * user's branch. A direct file copy of the deleted state is the faithful,
 * non-surprising backup. (#1692)
 *
 * @param directory  project root (contains `.swarm/`)
 * @param kind       backup label prefix ('reset' | 'reset-session' | 'rollback')
 * @param relEntries entries relative to `.swarm/` to back up (files or dirs)
 * @param opts       backups root override (rollback restores use 'rollback-backups')
 */
export function backupSwarmStateBeforeReset(
	directory: string,
	kind: 'reset' | 'reset-session' | 'rollback',
	relEntries: string[],
	opts?: { backupsRoot?: ResetBackupsRoot },
): ResetBackupResult {
	const warnings: string[] = [];
	const copied: string[] = [];

	const swarmDir = path.join(directory, '.swarm');
	try {
		const stat = fs.lstatSync(swarmDir);
		// Refuse to operate on a redirected .swarm/ (symlink/junction), matching
		// the safety posture of handleCloseCommand.
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			return { backupDir: null, copied, warnings };
		}
	} catch {
		// .swarm/ absent (ENOENT) or unstattable — nothing to back up.
		return { backupDir: null, copied, warnings };
	}

	// Deterministic, filesystem-safe timestamp; ISO strings sort chronologically.
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const backupsRoot = path.join(swarmDir, opts?.backupsRoot ?? 'reset-backups');
	const backupDir = path.join(backupsRoot, `${kind}-${timestamp}`);

	let backupDirCreated = false;
	const ensureBackupDir = (): void => {
		if (!backupDirCreated) {
			fs.mkdirSync(backupDir, { recursive: true });
			backupDirCreated = true;
		}
	};

	for (const rel of relEntries) {
		let src: string;
		try {
			src = validateSwarmPath(directory, rel);
		} catch {
			warnings.push(`skipped backup of ${rel} (path validation failed)`);
			continue;
		}
		if (!fs.existsSync(src)) continue;
		try {
			ensureBackupDir();
			const dest = path.join(backupDir, rel);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			// Recursive copy handles both files and directories (e.g. summaries/,
			// session/, plan-export/SWARM_PLAN.json).
			fs.cpSync(src, dest, { recursive: true });
			copied.push(rel);
		} catch (err) {
			warnings.push(
				`failed to back up ${rel}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	if (copied.length === 0) {
		// Nothing existed to back up — remove the empty dir if we created one.
		if (backupDirCreated) {
			try {
				fs.rmSync(backupDir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
		return { backupDir: null, copied, warnings };
	}

	pruneOldResetBackups(backupsRoot, warnings);
	return { backupDir, copied, warnings };
}

/**
 * Keep only the newest RESET_BACKUP_RETENTION backup directories under
 * `.swarm/reset-backups/` (or the rollback root), deleting older ones. Names
 * are `<kind>-<ISO>` which sort chronologically, so lexical sort descending
 * yields newest-first.
 */
function pruneOldResetBackups(backupsRoot: string, warnings: string[]): void {
	try {
		const entries = fs
			.readdirSync(backupsRoot, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort()
			.reverse();
		for (const stale of entries.slice(RESET_BACKUP_RETENTION)) {
			try {
				fs.rmSync(path.join(backupsRoot, stale), {
					recursive: true,
					force: true,
				});
			} catch (err) {
				warnings.push(
					`failed to prune old backup ${stale}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	} catch (err) {
		warnings.push(
			`failed to prune old reset backups: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Back up the current bytes of each dirty tracked file a git-checkpoint
 * rollback is about to destroy via `git reset --hard` (#2946). Files are
 * copied by their REPO-RELATIVE paths into
 * `.swarm/rollback-backups/rollback-git-<ISO>/tracked/<repo-rel-path>`, so a
 * confirmed rollback is recoverable by copying the files back. Fail-open by
 * contract (same as the swarm-state backup): per-entry failures are warnings.
 */
export function backupTrackedChangesBeforeRollback(
	directory: string,
	repoRelPaths: string[],
): ResetBackupResult {
	const warnings: string[] = [];
	const copied: string[] = [];

	const swarmDir = path.join(directory, '.swarm');
	try {
		const stat = fs.lstatSync(swarmDir);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			return { backupDir: null, copied, warnings };
		}
	} catch {
		return { backupDir: null, copied, warnings };
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const backupsRoot = path.join(swarmDir, 'rollback-backups');
	const backupDir = path.join(backupsRoot, `rollback-git-${timestamp}`);

	let backupDirCreated = false;
	const ensureBackupDir = (): void => {
		if (!backupDirCreated) {
			fs.mkdirSync(backupDir, { recursive: true });
			backupDirCreated = true;
		}
	};

	for (const rel of repoRelPaths) {
		if (!rel) continue;
		const src = path.join(directory, rel);
		if (!fs.existsSync(src)) continue;
		try {
			ensureBackupDir();
			const dest = path.join(backupDir, 'tracked', rel);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.cpSync(src, dest, { recursive: true });
			copied.push(rel);
		} catch (err) {
			warnings.push(
				`failed to back up ${rel}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	if (copied.length === 0) {
		if (backupDirCreated) {
			try {
				fs.rmSync(backupDir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
		return { backupDir: null, copied, warnings };
	}

	pruneOldResetBackups(backupsRoot, warnings);
	return { backupDir, copied, warnings };
}
