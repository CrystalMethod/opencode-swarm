/**
 * Issue #2946: shared destruction measurement + candidate derivation for the
 * /swarm rollback two-step gate. Used by BOTH the command layer
 * (src/commands/rollback.ts) and the checkpoint tool sink
 * (src/tools/checkpoint.ts) so a token minted by one surface is consumable at
 * the other: the scope digest is computed over the IDENTICAL candidate set
 * derived by the functions in this module.
 *
 * Measurement contract (mirrors the #2508 close gate,
 * src/commands/close/orchestrator.ts):
 *  - a bare `.git` marker directory (#2127 accepted project root, no
 *    repository behind it) tracks nothing — a failed status read there is a
 *    determined "no tracked work" answer, not an unreadable status;
 *  - a status read failure inside a REAL repository (spawn error, timeout,
 *    nonzero exit — e.g. index.lock contention) is NEVER a clean tree: the
 *    caller must refuse the destructive restore instead of proceeding.
 */
import { spawnSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { resolveGitExecutable } from '../utils/git-executable.js';
import type { PurgeCandidate } from './destructive-purge';

/** Destructive-surface kind for the git checkpoint restore path. */
export const ROLLBACK_GIT_KIND = 'swarm-rollback-git';
/** Destructive-surface kind for the legacy phase-overwrite restore path. */
export const ROLLBACK_PHASE_KIND = 'swarm-rollback-phase';

const GIT_STATUS_TIMEOUT_MS = 10_000;

/**
 * Test seam for the rollback gate (simulate git-status read failures without
 * spawning real git). Mirrors `_closeGateInternals.runGit`.
 */
export const _rollbackGateInternals: {
	runGit: (args: string[], cwd: string) => string | null;
} = {
	runGit: (args, cwd) => {
		const result = spawnSync(resolveGitExecutable(), args, {
			cwd,
			encoding: 'utf-8',
			timeout: GIT_STATUS_TIMEOUT_MS,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		if (result.error || result.status !== 0) return null;
		return result.stdout ?? '';
	},
};

/**
 * A real git repository root: `.git` is a linked-worktree/submodule pointer
 * file, or a directory carrying the HEAD ref every repository has. Bare
 * `.git` marker directories — accepted project roots per #2127 — are not
 * repositories; git tracks nothing there.
 */
export function isRealGitRepository(directory: string): boolean {
	try {
		if (fsSync.statSync(path.join(directory, '.git')).isFile()) return true;
	} catch {
		return false;
	}
	return fsSync.existsSync(path.join(directory, '.git', 'HEAD'));
}

/**
 * Parse `git status --porcelain` output into repo-relative tracked-dirty
 * paths. Untracked ('??') entries survive `git reset --hard`; every other
 * porcelain code is tracked work the reset would discard. Renames put BOTH
 * sides at risk (#2508), so each side is listed.
 */
export function parseTrackedDirtyPaths(statusOutput: string): string[] {
	const dirtyPaths: string[] = [];
	for (const line of statusOutput.split('\n')) {
		if (!line) continue;
		if (line.startsWith('??')) continue;
		const filePath = line.slice(3).trim().replace(/^"|"$/g, '');
		if (!filePath) continue;
		if (line.startsWith('R') && filePath.includes(' -> ')) {
			for (const side of filePath.split(' -> ')) {
				if (side) dirtyPaths.push(side);
			}
		} else {
			dirtyPaths.push(filePath);
		}
	}
	return dirtyPaths;
}

/**
 * The git-kind candidate set: the absolute paths of tracked-dirty files that
 * `git reset --hard` would destroy. This is the ONLY derivation for
 * ROLLBACK_GIT_KIND — the tool sink re-derives it from {label, directory}
 * alone, so the command layer must not add anything to the set.
 */
export function trackedDirtyCandidates(
	directory: string,
	dirtyRelPaths: string[],
): PurgeCandidate[] {
	return dirtyRelPaths.map((rel) => ({
		path: path.join(directory, rel),
		reason: 'uncommitted tracked change — destroyed by git reset --hard',
	}));
}

/**
 * The legacy-phase-kind candidate set: absolute paths of live `.swarm/`
 * entries the checkpoint copy loop would overwrite.
 */
export function swarmOverwriteCandidates(
	directory: string,
	overwriteRelPaths: string[],
): PurgeCandidate[] {
	return overwriteRelPaths.map((rel) => ({
		path: path.join(directory, '.swarm', rel),
		reason: 'live .swarm state replaced by the checkpoint copy',
	}));
}

/**
 * Measure the tracked-dirt destruction scope for a git checkpoint restore.
 * `unreadable` means git status could not be read inside a real repository —
 * callers must fail closed on it (never treat it as a clean tree). A non-git
 * or bare-marker root returns an empty dirty set: nothing tracked to destroy.
 */
export function measureGitDestruction(
	directory: string,
): { kind: 'ok'; dirtyRelPaths: string[] } | { kind: 'unreadable' } {
	if (!isRealGitRepository(directory)) {
		return { kind: 'ok', dirtyRelPaths: [] };
	}
	const status = _rollbackGateInternals.runGit(
		['status', '--porcelain'],
		directory,
	);
	if (status === null) {
		return { kind: 'unreadable' };
	}
	return { kind: 'ok', dirtyRelPaths: parseTrackedDirtyPaths(status) };
}
