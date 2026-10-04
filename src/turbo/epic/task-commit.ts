/**
 * Auto-commit on task completion — Rule 2 of the greenfield-smart redesign.
 *
 * When an epic is open for the project's current plan and it is a git repo,
 * `update_task_status` calls `commitTaskCompletion` after a task transitions
 * to `completed` and the durable plan write has succeeded. The resulting
 * commit serves two purposes:
 *
 *   1. **The task's work lands on the epic branch** before dependent waves
 *      start (coders need a clean baseline).
 *
 *   2. **Parallel-eligibility evidence (Rule 3).** Downstream tasks can
 *      require their `depends:` upstream to be *committed* (not just
 *      marked complete) before they fan out. The commit message format
 *      `swarm(task <id>): ...` is the searchable marker
 *      `epic_next_wave` reads through `plan-key.ts`
 *      (`readPlanScopedCommittedTaskIds`) as predecessor evidence.
 *
 * Failure handling: every step degrades non-fatally. A failed commit must
 * never block the durable task-status update — the plan ledger is the
 * authoritative source (AGENTS.md #5), git is a downstream artifact.
 *
 * Subprocess discipline: delegates to `src/git/branch.ts`, which already
 * enforces AGENTS.md #3 (explicit cwd, bounded timeout, array-form spawn,
 * non-interactive). This module adds no new subprocess primitives.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals as gitBranchInternals,
	isGitRepo as isGitRepo_import,
} from '../../git/branch.js';
import { criticalWarn } from '../../utils/logger.js';
import {
	formatSwarmPlanTrailer,
	hasPlanScopedTaskMarker,
	type PlanMarkerScope,
	scrubTaskIdForGitSubject,
} from './plan-key.js';

/** Result of a single task-commit attempt. */
export interface CommitTaskCompletionResult {
	/**
	 * `true` when a `swarm(task <id>):` marker for this taskId is present
	 * in git history at function exit — whether this call produced it
	 * (`reason: 'success'`) or whether an earlier call did
	 * (`reason: 'idempotent-skip'`).
	 *
	 * Phase 17 (B.M9): pre-Phase-17 the `'already-committed'` reason
	 * returned `committed: false`, self-contradicting ("not committed
	 * because already committed"). Architect LLMs interpreted the
	 * `false` as a failure and retried, producing log noise. The fixed
	 * semantic: `committed` answers "is the marker in git for this
	 * taskId now?" — yes for both the fresh-write and the idempotent
	 * skip paths.
	 */
	committed: boolean;
	/**
	 * - `scope-unresolved`: no declared scope could be resolved for the task
	 *   AND the working tree holds non-`.swarm` changes (or its state could
	 *   not be read). No marker is written — a marker-only commit would let
	 *   Rule 3 treat the task as committed while its changes stay
	 *   uncommitted. `error` carries the operator remediation.
	 */
	reason:
		| 'no-git'
		| 'commit-failed'
		| 'success'
		| 'idempotent-skip'
		| 'scope-unresolved';
	sha?: string;
	error?: string;
}

/** Literal pathspec for an exact file path (no glob interpretation). */
function literalPathspec(p: string): string {
	return `:(literal)${p}`;
}

/**
 * Upper bound on the combined byte length of scope paths passed inline as
 * `git commit` argv. Windows caps the whole command line at 32 767 chars;
 * 24 KiB leaves room for the executable, `-c` hardening flags, and message.
 * Larger scopes go through `--pathspec-from-file` instead.
 */
const COMMIT_ARGV_PATHSPEC_BUDGET_BYTES = 24 * 1024;

/** True for a `git status -z` path inside a `.swarm/` directory (any depth). */
function isSwarmStatePath(p: string): boolean {
	const normalized = p.replace(/\\/g, '/');
	return (
		normalized === '.swarm' ||
		normalized.startsWith('.swarm/') ||
		normalized.includes('/.swarm/') ||
		normalized.endsWith('/.swarm')
	);
}

/**
 * Parse `git status --porcelain=v1 -z` output into changed paths. Rename /
 * copy records carry a second (origin) NUL-terminated path, which is also a
 * change and is returned too.
 */
export function parsePorcelainZPaths(output: string): string[] {
	const tokens = output.split('\0');
	const paths: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const record = tokens[i];
		if (record.length < 4) continue;
		const xy = record.slice(0, 2);
		paths.push(record.slice(3));
		if ((xy[0] === 'R' || xy[0] === 'C') && i + 1 < tokens.length) {
			i += 1;
			if (tokens[i].length > 0) paths.push(tokens[i]);
		}
	}
	return paths;
}

/**
 * Build the marker commit message. The `swarm(task <id>):` subject prefix is
 * the searchable marker Rule 2's idempotency guard and Rule 3 consume; the
 * `Swarm-Plan: <planKey>` trailer binds it to the plan that wrote it (Epic v2
 * C0, see `./plan-key.ts`) so a previous plan's marker for the same task id
 * is never honored. Treat both as a stable contract. The description is
 * truncated to keep the subject within git's conventional 72-char window.
 * The task id is scrubbed by `scrubTaskIdForGitSubject` (Phase 17 C.H2).
 */
export function formatTaskCommitMessage(
	taskId: string,
	planKey: string,
	description?: string,
): string {
	const safeId = scrubTaskIdForGitSubject(taskId);
	const summary = (description ?? 'completed').replace(/\s+/g, ' ').trim();
	const truncated =
		summary.length > 60 ? `${summary.slice(0, 57)}...` : summary;
	return `swarm(task ${safeId}): ${truncated || 'completed'}\n\n${formatSwarmPlanTrailer(planKey)}`;
}

/**
 * Stage this task's declared scope and create a marker commit.
 *
 * - **No-op when not a git repo**: returns `{ committed: false, reason: 'no-git' }`.
 *   Rule 1 in the redesign — non-git projects skip the entire commit flow.
 * - **Scope-bounded staging AND commit**: when `scopePaths` is non-empty,
 *   only those paths are staged (plus the AGENTS.md #4 `.swarm` exclude)
 *   and the commit itself is restricted to them (`--only` pathspec). The
 *   previous `git add -A` approach swept in sibling lanes' work-in-progress
 *   under parallel dispatch — the adversarial review on 2026-06-03 found
 *   that each `swarm(task A):` commit was actually containing fragments of
 *   lanes B/C/D, corrupting Rule 3's evidence — and a pathspec-less commit
 *   still swept in anything pre-staged in the index.
 * - **No-scope path**: when `scopePaths` is undefined or empty, an empty
 *   `--allow-empty --only` marker is written ONLY if the working tree has no
 *   non-`.swarm` change (pure verification tasks, `.swarm`-only output).
 *   The marker advances `commitsObserved` so Rule 4's greenfield gate still
 *   opens, and preserves Rule 3 evidence. When the tree IS dirty (or its
 *   status cannot be read) the scope is merely unresolvable — an expired
 *   binding, a revised plan — and the task's changes would stay uncommitted
 *   behind a marker claiming otherwise, so the call returns
 *   `reason: 'scope-unresolved'` and raises a criticalWarn with remediation.
 * - **Non-fatal on git failures**: logs and returns `commit-failed`. The
 *   plan ledger is authoritative per AGENTS.md #5; git is downstream.
 */
/**
 * Phase 11 (B5): bounded retry-with-backoff schedule for `index.lock`
 * contention. Under concurrent dispatch (4+ sub-agents finishing within
 * seconds), git serialises through `.git/index.lock` and the loser of
 * the race gets `fatal: Unable to create '.git/index.lock': File
 * exists.` Without retry, that loser silently degrades to `commit-failed`
 * and the marker is lost — cascading into a Phase 10 predecessor-
 * evidence failure on the next phase. The schedule below covers up to
 * ~1.5 s of accumulated wait; git typically releases the lock in
 * <100 ms, so the first retry usually wins. Three attempts after the
 * initial try gives 4 chances total — enough to survive a 4-lane burst
 * with high probability.
 *
 * Detection uses the canonical git error substring; we deliberately do
 * NOT match on `fatal:` alone (too broad) or on exit-code (already
 * surfaced as non-zero).
 */
const INDEX_LOCK_BACKOFF_MS: readonly number[] = [100, 200, 400, 800];
const INDEX_LOCK_ERROR_RE = /index\.lock|unable to create.*\.lock/i;

function isLockContentionError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return INDEX_LOCK_ERROR_RE.test(msg);
}

export async function commitTaskCompletion(
	directory: string,
	taskId: string,
	description: string | undefined,
	scopePaths: string[] | undefined,
	markerScope: PlanMarkerScope,
): Promise<CommitTaskCompletionResult> {
	// Probe for git repo first. `isGitRepo` throws nothing — it returns
	// `false` on any failure path (`git rev-parse --git-dir` non-zero exit
	// or spawn error).
	if (!_internals.isGitRepo(directory)) {
		return { committed: false, reason: 'no-git' };
	}

	// Idempotency guard (Phase 8): if a `swarm(task <id>):` marker for
	// this taskId already exists for the CURRENT plan (Epic v2 C0: matching
	// `Swarm-Plan:` trailer, or a legacy trailer-less marker committed
	// at/after the plan root), do not produce a second one. A previous
	// plan's marker for the same id is ignored. `updateTaskStatus(..., 'completed')` can legitimately fire
	// multiple times — council re-runs, status corrections, retry-after-
	// error, recovery flows. Without this guard each repeat call mints
	// another empty marker, polluting history and over-counting
	// `commitsObserved` for Rule 4's greenfield gate. A failed `git log`
	// here means "we can't tell" — fall through and commit (correctness
	// over polish; better a possible duplicate than a silent skip when
	// detection is broken).
	try {
		if (_internals.hasExistingTaskCommit(directory, taskId, markerScope)) {
			// Phase 17 (B.M9): `committed: true` because the marker IS
			// in git history (we just didn't write it this call). This
			// fixes the architect-LLM-retry loop where `committed: false`
			// looked like a failure.
			return { committed: true, reason: 'idempotent-skip' };
		}
	} catch {
		/* duplicate-detection is best-effort; proceed with commit */
	}

	// Phase 17 (C.H6): reject scope entries that look like git pathspec
	// magic (`:(glob)**`, `:!**`, etc.). An LLM-authored scope of
	// `:(glob)**` would be passed to `git add --` and stage the entire
	// tree, broadening Rule 2's commit beyond declared intent and
	// corrupting Rule 3's evidence (the marker would contain files the
	// next task expected to own). The `--` separator does NOT block
	// pathspec magic — only argv-option parsing. Strip the leading `:`
	// entries entirely; surface them via the criticalWarn for operator
	// visibility.
	const rawPaths = (scopePaths ?? []).filter(
		(p) => typeof p === 'string' && p.trim().length > 0,
	);
	const droppedMagic: string[] = [];
	const paths = rawPaths.filter((p) => {
		if (p.startsWith(':')) {
			droppedMagic.push(p);
			return false;
		}
		return true;
	});
	if (droppedMagic.length > 0) {
		criticalWarn(
			`[epic:task-commit] dropped ${droppedMagic.length} scope path(s) starting with ':' (git pathspec magic, not allowed): ${droppedMagic.slice(0, 5).join(', ')}${droppedMagic.length > 5 ? `, +${droppedMagic.length - 5} more` : ''}. Architect should declare literal file paths only.`,
		);
	}
	const message = formatTaskCommitMessage(
		taskId,
		markerScope.planKey,
		description,
	);

	// No resolvable scope: a marker-only commit is correct ONLY when the task
	// left nothing outside `.swarm/` to commit (pure verification tasks,
	// `.swarm`-only output). When the tree is dirty — e.g. the 1 h scope
	// binding expired before completion, the plan was revised, or a worktree
	// squash landing left the task's changes unstaged — writing the marker
	// would let Rule 3 treat the task as committed while its changes stay
	// uncommitted. Refuse instead and tell the operator how to recover. A
	// status read failure is "unknown" and refused the same way (fail-closed
	// for Rule 3 evidence).
	if (paths.length === 0) {
		let dirtyPaths: string[] | null = null;
		let statusError: string | undefined;
		try {
			dirtyPaths = _internals
				.listChangedPaths(directory)
				.filter((p) => !isSwarmStatePath(p));
		} catch (err) {
			statusError = err instanceof Error ? err.message : String(err);
		}
		if (dirtyPaths === null || dirtyPaths.length > 0) {
			const detail =
				dirtyPaths === null
					? `working-tree status could not be read (${statusError})`
					: `${dirtyPaths.length} uncommitted non-.swarm path(s) present: ${dirtyPaths.slice(0, 5).join(', ')}${dirtyPaths.length > 5 ? `, +${dirtyPaths.length - 5} more` : ''}`;
			const remediation = `No declared scope could be resolved for task ${taskId} (scope binding missing, expired, or declared against a different plan revision) and ${detail}. No \`swarm(task ${scrubTaskIdForGitSubject(taskId)}):\` marker was written, so Rule 3 will NOT treat this task as committed. Remediation: re-run \`declare_scope\` for task ${taskId} and then re-run its completion (\`update_task_status\` → completed), OR commit the task's changes manually with a subject starting \`swarm(task ${scrubTaskIdForGitSubject(taskId)}):\` and a final \`${formatSwarmPlanTrailer(markerScope.planKey)}\` trailer line.`;
			criticalWarn(`[epic:task-commit] ${remediation}`);
			return {
				committed: false,
				reason: 'scope-unresolved',
				error: remediation,
			};
		}
	}

	// Phase 11 (B5): bounded retry loop over the stage+commit pair. If
	// either step fails with a lock-contention error AND we have retries
	// left, sleep and re-attempt. Any other failure (or the final attempt)
	// degrades to the non-fatal commit-failed return path.
	let lastError: unknown = null;
	for (let attempt = 0; attempt <= INDEX_LOCK_BACKOFF_MS.length; attempt++) {
		try {
			const files =
				paths.length > 0 ? _internals.stageScopedPaths(directory, paths) : [];
			// `commitScopedPaths` uses `--only` semantics: ONLY the task's
			// in-scope files land in the marker commit, so anything else
			// already in the index (user WIP, a sibling lane's staged files)
			// stays staged and out of this task's commit. With no files it
			// produces an empty marker that likewise ignores the index.
			_internals.commitScopedPaths(directory, message, files);
			const sha = _internals.gitHeadSha(directory);
			return { committed: true, reason: 'success', sha };
		} catch (err) {
			lastError = err;
			if (
				attempt < INDEX_LOCK_BACKOFF_MS.length &&
				isLockContentionError(err)
			) {
				await _internals.sleep(INDEX_LOCK_BACKOFF_MS[attempt]);
				continue;
			}
			break;
		}
	}

	const msg =
		lastError instanceof Error ? lastError.message : String(lastError);
	// Phase 15 (B34): elevated to criticalWarn so the operator sees Rule 2
	// commit failures during a live benchmark. Pre-Phase-15 this was a
	// debug-gated warn — silent unless OPENCODE_SWARM_DEBUG=1 — and the
	// operator had no way to know greenfield-gate progress was being lost.
	criticalWarn(
		`[epic:task-commit] commit for task ${taskId} failed (non-fatal): ${msg}`,
	);
	return { committed: false, reason: 'commit-failed', error: msg };
}

/**
 * Parse `git diff --name-status -z` output into `[source, destination]`
 * pairs for rename records (`R<score>\0src\0dst\0`). Copy records
 * (`C<score>`) carry two paths but no source deletion and are skipped, as
 * are single-path records. Exported for tests.
 */
export function parseRenamePairsZ(output: string): Array<[string, string]> {
	const parts = output.split('\0');
	const pairs: Array<[string, string]> = [];
	let i = 0;
	while (i < parts.length) {
		const status = parts[i] ?? '';
		if (status.length === 0) {
			i += 1;
			continue;
		}
		if (status.startsWith('R') || status.startsWith('C')) {
			const source = parts[i + 1];
			const destination = parts[i + 2];
			if (status.startsWith('R') && source && destination) {
				pairs.push([source, destination]);
			}
			i += 3;
			continue;
		}
		i += 2;
	}
	return pairs;
}

/**
 * DI seam — production code calls through `_internals.<name>` so tests
 * substitute deterministic doubles without `mock.module`'s cross-file
 * leak (AGENTS.md invariant 7). Restore in `afterEach`.
 */
export const _internals = {
	isGitRepo: (cwd: string) => isGitRepo_import(cwd),
	/**
	 * Stage the task's declared scope and return the exact files the marker
	 * commit must contain (cwd-relative, `.swarm/` excluded at any depth).
	 *
	 * AGENTS.md #4: `.swarm/` content must never reach git history, whatever
	 * the scope says and whatever the user's `.gitignore` holds. That is
	 * enforced by filtering discovered paths in JS — NOT by an
	 * `:(exclude,glob)**\/.swarm/**` pathspec on `git add`: on git 2.43 that
	 * exclude made `git add -- <new file in a new nested dir> <exclude>` exit
	 * 0 while staging NOTHING (directory-traversal dependent, e.g. it failed
	 * for `trk/n2/n3/f.ts` yet worked for `c1/d1/e1/f.ts`), silently
	 * dropping the task's new files from its commit.
	 *
	 *  1. `git ls-files -z --others --modified --exclude-standard --
	 *     :(literal)<scope>` discovers untracked (non-ignored), modified and
	 *     deleted files under the scope paths (literal: a scope entry like
	 *     `src/*.ts` or `app/[id].tsx` names exactly that path — never a
	 *     glob sweeping sibling WIP; a directory entry still matches
	 *     everything beneath it);
	 *  2. `.swarm` paths are dropped; the rest is staged with
	 *     `git add -A -- :(literal)<file>` (literal: `app/[id].tsx` must not
	 *     glob-match `app/i.tsx`);
	 *  3. `git diff --cached --name-only --no-renames --relative --
	 *     :(literal)<scope>` yields every staged change within scope
	 *     (including files staged by an earlier lock-contention attempt and
	 *     both sides of a rename), again minus `.swarm`;
	 *  4. for every staged rename whose destination is in that set, the
	 *     source path is added too, so the commit carries the deletion.
	 *
	 * Phase 17 (E.3): every git call is chunked (200 paths) so monorepo-scale
	 * scopes never exceed `ARG_MAX` (~256 KB macOS, 32 767 chars Windows).
	 * A scope path that matches nothing is simply absent from the result.
	 */
	stageScopedPaths: (cwd: string, paths: string[]): string[] => {
		const CHUNK = 200;
		const chunked = <T>(items: T[]): T[][] => {
			const out: T[][] = [];
			for (let i = 0; i < items.length; i += CHUNK) {
				out.push(items.slice(i, i + CHUNK));
			}
			return out;
		};
		const splitZ = (output: string): string[] =>
			output.split('\0').filter((p) => p.length > 0 && !isSwarmStatePath(p));

		const discovered = new Set<string>();
		for (const chunk of chunked(paths)) {
			const out = gitBranchInternals.gitExec(
				[
					'ls-files',
					'-z',
					'--others',
					'--modified',
					'--exclude-standard',
					'--',
					...chunk.map(literalPathspec),
				],
				cwd,
			);
			for (const p of splitZ(out)) discovered.add(p);
		}
		for (const chunk of chunked([...discovered])) {
			gitBranchInternals.gitExec(
				['add', '-A', '--', ...chunk.map(literalPathspec)],
				cwd,
			);
		}
		const staged = new Set<string>();
		for (const chunk of chunked(paths)) {
			const out = gitBranchInternals.gitExec(
				[
					'diff',
					'--cached',
					'--name-only',
					'-z',
					'--no-renames',
					'--relative',
					'--',
					...chunk.map(literalPathspec),
				],
				cwd,
			);
			for (const p of splitZ(out)) staged.add(p);
		}
		// A staged rename (`git mv old new`) whose DESTINATION is in scope
		// must carry its source-path deletion into the same commit; otherwise
		// `--only -- new` commits just the addition and leaves `old` staged
		// as a dangling deletion. Detected index-wide (the source is usually
		// outside the declared scope) via rename-aware name-status.
		if (staged.size > 0) {
			const out = gitBranchInternals.gitExec(
				['diff', '--cached', '-M', '--name-status', '-z', '--relative'],
				cwd,
			);
			for (const [source, destination] of parseRenamePairsZ(out)) {
				if (staged.has(destination) && !isSwarmStatePath(source)) {
					staged.add(source);
				}
			}
		}
		return [...staged];
	},
	/**
	 * Marker commit restricted to the given files (`--only` semantics).
	 *
	 * Previously this ran `git commit --allow-empty` with NO pathspec, which
	 * commits the whole index — sweeping any pre-staged user or sibling-lane
	 * file into this task's `swarm(task <id>):` commit. Now:
	 *  - with files: `git commit --only -- :(literal)<file>...` commits
	 *    exactly those files (as staged by `stageScopedPaths`); every other
	 *    staged entry remains staged and out of the commit.
	 *  - without files: `--allow-empty --only` creates an empty marker
	 *    commit regardless of what is staged (git: "If used together with
	 *    --allow-empty paths are also not required, and an empty commit will
	 *    be created").
	 * File lists whose inline pathspec would exceed
	 * {@link COMMIT_ARGV_PATHSPEC_BUDGET_BYTES} are passed through a
	 * NUL-delimited `--pathspec-from-file` under the git dir (ARG_MAX /
	 * Windows command-line cap), removed in `finally`.
	 *
	 * `--allow-empty` keeps the marker even when the scope carried no change
	 * (Rule 3 evidence). Phase 8: `--no-verify` skips `pre-commit`,
	 * `commit-msg`, and `pre-commit-msg` hooks. Rule 2's commits are protocol
	 * markers, not user-authored content — running Biome/typecheck/lint on
	 * every task completion would add minutes of wall-clock per task and,
	 * worse, could block the marker entirely on a repo with a strict
	 * pre-commit gate. Plan ledger remains authoritative; the commit is the
	 * audit trail, not the gate.
	 */
	commitScopedPaths: (cwd: string, message: string, files: string[]) => {
		const base = [
			'commit',
			'--allow-empty',
			'--only',
			'--no-verify',
			'-m',
			message,
		];
		const pathspecs = files
			.filter((p) => !isSwarmStatePath(p))
			.map(literalPathspec);
		if (pathspecs.length === 0) {
			gitBranchInternals.gitExec(base, cwd);
			return;
		}
		const inlineBytes = pathspecs.reduce(
			(sum, p) => sum + Buffer.byteLength(p, 'utf-8') + 1,
			0,
		);
		if (inlineBytes <= COMMIT_ARGV_PATHSPEC_BUDGET_BYTES) {
			gitBranchInternals.gitExec([...base, '--', ...pathspecs], cwd);
			return;
		}
		const gitPath = gitBranchInternals
			.gitExec(
				[
					'rev-parse',
					'--git-path',
					`swarm-rule2-pathspec-${process.pid}-${Date.now()}`,
				],
				cwd,
			)
			.trim();
		const specFile = path.resolve(cwd, gitPath);
		try {
			fs.writeFileSync(specFile, `${pathspecs.join('\0')}\0`, 'utf-8');
			gitBranchInternals.gitExec(
				[...base, `--pathspec-from-file=${specFile}`, '--pathspec-file-nul'],
				cwd,
			);
		} finally {
			try {
				fs.rmSync(specFile, { force: true });
			} catch {
				/* best-effort cleanup of the transient pathspec file */
			}
		}
	},
	/**
	 * Paths with any working-tree, index, or untracked change (porcelain v1,
	 * NUL-delimited so unusual file names parse exactly). Throws on git
	 * failure — the caller treats that as "unknown" and refuses the marker.
	 */
	listChangedPaths: (cwd: string): string[] =>
		parsePorcelainZPaths(
			gitBranchInternals.gitExec(
				['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
				cwd,
			),
		),
	gitHeadSha: (cwd: string) => {
		return gitBranchInternals.gitExec(['rev-parse', 'HEAD'], cwd).trim();
	},
	/**
	 * Phase 11 (B5): async sleep used by `commitTaskCompletion`'s
	 * retry loop. Routed through `_internals` so tests can substitute
	 * a no-op stub and not actually wait during fast-path unit tests.
	 */
	sleep: (ms: number): Promise<void> =>
		new Promise((resolve) => setTimeout(resolve, ms)),
	/**
	 * True when a marker for `taskId` that belongs to the current plan is in
	 * git history (Epic v2 C0, `plan-key.ts`): one bounded `git log` read
	 * bounded by the marker `--grep` and `--max-count`, with the
	 * `Swarm-Plan:` trailer and commit time (plan root) checked per record. Throws on git
	 * failure — the caller treats that as "unknown" and proceeds (a possible
	 * duplicate marker beats a silent skip).
	 */
	hasExistingTaskCommit: (
		cwd: string,
		taskId: string,
		markerScope: PlanMarkerScope,
	): boolean => hasPlanScopedTaskMarker(cwd, taskId, markerScope),
};
