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
			warnings.push(
				'backup skipped: .swarm is a symlink or not a directory — nothing was backed up',
			);
			return { backupDir: null, copied, warnings };
		}
	} catch {
		// .swarm/ absent (ENOENT) or unstattable — nothing to back up, but the
		// caller must know the safety net is absent (#2976 review F-3).
		warnings.push(
			'backup skipped: .swarm directory is missing — nothing was backed up',
		);
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

	pruneOldResetBackups(backupsRoot, warnings, path.basename(backupDir));
	return { backupDir, copied, warnings };
}

/**
 * Backup-directory names are `<kind>-<ISO>` where kind itself contains
 * dashes (`reset`, `reset-session`, `rollback`, `rollback-git`), so a raw
 * lexical sort compares the PREFIX before the timestamp and ranks
 * `rollback-git-*` ("g") above any digit-led older timestamp — a freshly
 * created `rollback-<ISO>` backup could be pruned in the same call that
 * made it (#2976 review F-4; the same shape pre-existed between
 * `reset-session-` and `reset-`). Sort on the TIMESTAMP suffix instead:
 * `toISOString().replace(/[:.]/g, '-')` always yields 17 digits, so the
 * digit-run compares correctly as a fixed-length string. The directory
 * created by the current call is never a prune candidate.
 */
const BACKUP_KIND_PREFIXES = [
	'reset-session-',
	'rollback-git-',
	'rollback-',
	'reset-',
] as const;

function backupTimestampSortKey(name: string): string {
	for (const prefix of BACKUP_KIND_PREFIXES) {
		if (name.startsWith(prefix)) {
			return name.slice(prefix.length).replace(/\D/g, '');
		}
	}
	return '';
}

function pruneOldResetBackups(
	backupsRoot: string,
	warnings: string[],
	keepDirName?: string,
): void {
	try {
		const entries = fs
			.readdirSync(backupsRoot, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => ({ name: e.name, key: backupTimestampSortKey(e.name) }))
			.sort((a, b) =>
				a.key === b.key
					? b.name.localeCompare(a.name)
					: b.key.localeCompare(a.key),
			);
		for (const stale of entries.slice(RESET_BACKUP_RETENTION)) {
			// Belt and braces: the directory this call just created ranks
			// newest under the timestamp sort, so it is never in this tail —
			// but never delete it even if a future ranking change would.
			if (stale.name === keepDirName) continue;
			try {
				fs.rmSync(path.join(backupsRoot, stale.name), {
					recursive: true,
					force: true,
				});
			} catch (err) {
				warnings.push(
					`failed to prune old backup ${stale.name}: ${err instanceof Error ? err.message : String(err)}`,
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
			warnings.push(
				'backup skipped: .swarm is a symlink or not a directory — nothing was backed up',
			);
			return { backupDir: null, copied, warnings };
		}
	} catch {
		warnings.push(
			'backup skipped: .swarm directory is missing — nothing was backed up',
		);
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

	pruneOldResetBackups(backupsRoot, warnings, path.basename(backupDir));
	return { backupDir, copied, warnings };
}
