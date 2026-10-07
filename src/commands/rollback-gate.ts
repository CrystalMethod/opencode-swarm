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
// `git ls-tree -r` / `git ls-files` on large repositories can exceed the
// 1 MB spawnSync default; the scan is still bounded by this explicit cap.
const GIT_LIST_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * Test seam for the rollback gate (simulate git-status read failures without
 * spawning real git). Mirrors `_closeGateInternals.runGit`.
 */
export const _rollbackGateInternals: {
	runGit: (args: string[], cwd: string) => string | null;
	runGitBuffered: (args: string[], cwd: string) => string | null;
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
	runGitBuffered: (args, cwd) => {
		const result = spawnSync(resolveGitExecutable(), args, {
			cwd,
			encoding: 'utf-8',
			timeout: GIT_STATUS_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: GIT_LIST_MAX_BUFFER_BYTES,
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
 * Parse `git status --porcelain -z` output into repo-relative tracked-dirty
 * paths. The -z form is NUL-terminated and NEVER quotes paths (core.quotepath
 * quoting — which mangles non-ASCII names into C-escaped octal and would
 * silently break both the preview and the pre-restore backup — does not
 * apply). Untracked ('??') entries survive `git reset --hard`; every other
 * porcelain code is tracked work the reset would discard. Rename/copy
 * records carry the ORIG_PATH as the next NUL token (#2508: both sides at
 * risk), so each side is listed. R/C may sit in EITHER status column — the
 * second column for worktree-only renames created via `git add -N`
 * (intent-to-add) — so the test must not anchor to the first column, or the
 * ORIG_PATH token of an R/C-initial file (README.md, CHANGELOG.md, …) is
 * misread as the start of a new record and swallows the next real entry.
 */
export function parseTrackedDirtyPaths(statusOutput: string): string[] {
	const dirtyPaths: string[] = [];
	const tokens = statusOutput.split('\0');
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === '' || token.length < 4) continue;
		const xy = token.slice(0, 2);
		if (xy === '??') continue;
		const filePath = token.slice(3);
		if (!filePath) continue;
		dirtyPaths.push(filePath);
		if (/[RC]/.test(xy) && i + 1 < tokens.length && tokens[i + 1] !== '') {
			dirtyPaths.push(tokens[i + 1]);
			i += 1;
		}
	}
	return dirtyPaths;
}

/**
 * Paths that live in the restore TARGET tree but are NOT in the current
 * index while a file sits on disk at that path. `git reset --hard` silently
 * overwrites exactly these untracked (or since-ignored) files when it
 * materializes the target tree, so they belong in the destruction scope
 * alongside tracked-dirty paths (#2976 review F-1). Returns [] when either
 * listing cannot be read — the tracked-dirty gate above still applies, and
 * the caller's unreadable-status refusal covers real-repo failures.
 */
export function untrackedPathsInTargetTree(
	directory: string,
	targetSha: string,
): string[] {
	if (!isRealGitRepository(directory)) return [];
	const targetTree = _rollbackGateInternals.runGitBuffered(
		['ls-tree', '-r', '-z', '--name-only', targetSha],
		directory,
	);
	const index = _rollbackGateInternals.runGitBuffered(
		['ls-files', '-z'],
		directory,
	);
	if (targetTree === null || index === null) return [];
	const indexed = new Set(index.split('\0').filter((p) => p !== ''));
	const inWay: string[] = [];
	for (const rel of targetTree.split('\0')) {
		if (rel === '' || indexed.has(rel)) continue;
		if (fsSync.existsSync(path.join(directory, rel))) inWay.push(rel);
	}
	return inWay;
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
 * Measure the destruction scope for a git checkpoint restore. When
 * `targetSha` is provided, files that are untracked (or since-ignored) on
 * disk but tracked in the TARGET tree are included: `git reset --hard`
 * overwrites them silently, so they are part of the destruction set
 * (#2976 review F-1). `unreadable` means git status could not be read
 * inside a real repository — callers must fail closed on it (never treat
 * it as a clean tree). A non-git or bare-marker root returns an empty
 * dirty set: nothing tracked to destroy.
 */
export function measureGitDestruction(
	directory: string,
	targetSha?: string,
): { kind: 'ok'; dirtyRelPaths: string[] } | { kind: 'unreadable' } {
	if (!isRealGitRepository(directory)) {
		return { kind: 'ok', dirtyRelPaths: [] };
	}
	const status = _rollbackGateInternals.runGit(
		['status', '--porcelain', '-z'],
		directory,
	);
	if (status === null) {
		return { kind: 'unreadable' };
	}
	const dirtyRelPaths = parseTrackedDirtyPaths(status);
	if (targetSha) {
		for (const rel of untrackedPathsInTargetTree(directory, targetSha)) {
			if (!dirtyRelPaths.includes(rel)) dirtyRelPaths.push(rel);
		}
	}
	return { kind: 'ok', dirtyRelPaths };
}
