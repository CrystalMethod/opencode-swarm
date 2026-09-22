/**
 * Diff scope validator — compares files changed in git against the declared scope
 * for a given task in plan.json. Returns a warning string if undeclared files
 * were modified, or null if in-scope, no scope declared, or git unavailable.
 * Never throws.
 *
 * Issue #2818: the repository's latest commit belongs to whichever task
 * committed last, so a repository-wide `git diff HEAD~1` mis-attributes a
 * concurrent task's files to the task being checked. When the caller can
 * supply the task's own attribution record (`modifiedFilesByTask`), the
 * comparison runs against that per-task file set instead. Without an
 * attribution record the legacy repository-wide comparison is kept, and the
 * warning names its evidence (diff basis + latest commit) so a reader can
 * detect possible mis-attribution.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunSpawn } from '../utils/bun-compat';
import { resolveGitExecutable } from '../utils/git-executable.js';
import { ENSURE_SWARM_GIT_EXCLUDED_PER_CALL_TIMEOUT_MS } from '../utils/gitignore-warning';

/**
 * Test-only dependency-injection seam — see `gitignore-warning.ts:_internals`
 * for the rationale (`mock.module` from `bun:test` leaks across files in
 * Bun's shared test-runner process). Mutating this local object is
 * file-scoped and trivially restorable via `afterEach`.
 */
export const _internals: {
	bunSpawn: typeof bunSpawn;
	/**
	 * Test seam for git binary resolution (issue #2236 hardening, lane C1b).
	 * This hook is not on the plugin init path, so the synchronous resolver
	 * is used (unlike `gitignore-warning.ts`, which must use the async one).
	 */
	resolveGitExecutable: typeof resolveGitExecutable;
} = { bunSpawn, resolveGitExecutable };

/**
 * Optional per-task attribution source supplied by the caller.
 * When `attributedFiles` is a non-empty array it is the task's own
 * modified-file set (the session's coder-settlement attribution record) and
 * the repository-wide git diff is not consulted at all.
 */
export interface DiffScopeAttribution {
	attributedFiles?: readonly string[];
}

/**
 * Read the declared file scope for a task from .swarm/plan.json.
 * Returns the files array or null if not found / no scope declared.
 */
function getDeclaredScope(taskId: string, directory: string): string[] | null {
	try {
		const planPath = path.join(directory, '.swarm', 'plan.json');
		if (!fs.existsSync(planPath)) return null;

		const raw = fs.readFileSync(planPath, 'utf-8');
		const plan = JSON.parse(raw) as {
			phases?: Array<{
				tasks?: Array<{
					id?: string;
					files_touched?: string | string[];
				}>;
			}>;
		};

		for (const phase of plan.phases ?? []) {
			for (const task of phase.tasks ?? []) {
				if (task.id !== taskId) continue;
				const ft = task.files_touched;
				if (Array.isArray(ft) && ft.length > 0) {
					return ft;
				}
				if (typeof ft === 'string' && ft.length > 0) {
					return [ft];
				}
				return null; // Task found but no scope declared
			}
		}
		return null; // Task not found
	} catch {
		return null;
	}
}

/**
 * Which git diff leg produced the changed-file set.
 */
type DiffBasis = 'HEAD~1' | 'HEAD';

interface ChangedFilesResult {
	files: string[] | null;
	basis: DiffBasis;
}

/**
 * Run git diff --name-only to get files changed since HEAD~1 (working tree
 * included). Returns the changed file paths plus the leg that produced them,
 * or { files: null } if git is unavailable.
 */
/**
 * Spawn options shared by the `git diff` / `git rev-parse` invocations below.
 *
 * `timeout` and `stdin: 'ignore'` are required to make the call hang-free on
 * every supported platform — see `gitignore-warning.ts` for full rationale.
 * Without `stdin: 'ignore'`, Bun on Windows may leave the child waiting for
 * a stdin EOF that never arrives; without `timeout`, the awaited
 * `Promise.all([proc.exited, proc.stdout.text()])` can block indefinitely
 * if antivirus / credential prompts / NFS stall the child.
 */
const GIT_DIFF_SPAWN_OPTIONS = {
	timeout: ENSURE_SWARM_GIT_EXCLUDED_PER_CALL_TIMEOUT_MS,
	stdin: 'ignore',
	stdout: 'pipe',
	stderr: 'pipe',
} as const;

async function getChangedFiles(directory: string): Promise<ChangedFilesResult> {
	try {
		// Issue #2236 hardening (lane C1b): resolve the git binary ONCE for
		// both spawn calls below.
		const gitExecutable = _internals.resolveGitExecutable();

		// Try HEAD~1 first (normal case with commits)
		const proc = _internals.bunSpawn(
			[gitExecutable, 'diff', '--name-only', 'HEAD~1'],
			{
				cwd: directory,
				...GIT_DIFF_SPAWN_OPTIONS,
			},
		);

		let exitCode: number;
		let stdout: string;
		try {
			[exitCode, stdout] = await Promise.all([proc.exited, proc.stdout.text()]);
		} finally {
			try {
				proc.kill();
			} catch {
				// Already exited — kill is a no-op.
			}
		}

		if (exitCode === 0) {
			return {
				files: stdout
					.trim()
					.split('\n')
					.map((f) => f.trim())
					.filter((f) => f.length > 0),
				basis: 'HEAD~1',
			};
		}

		// Fallback: uncommitted changes vs HEAD
		const proc2 = _internals.bunSpawn(
			[gitExecutable, 'diff', '--name-only', 'HEAD'],
			{
				cwd: directory,
				...GIT_DIFF_SPAWN_OPTIONS,
			},
		);

		let exitCode2: number;
		let stdout2: string;
		try {
			[exitCode2, stdout2] = await Promise.all([
				proc2.exited,
				proc2.stdout.text(),
			]);
		} finally {
			try {
				proc2.kill();
			} catch {
				// Already exited — kill is a no-op.
			}
		}

		if (exitCode2 === 0) {
			return {
				files: stdout2
					.trim()
					.split('\n')
					.map((f) => f.trim())
					.filter((f) => f.length > 0),
				basis: 'HEAD',
			};
		}

		return { files: null, basis: 'HEAD~1' };
	} catch {
		return { files: null, basis: 'HEAD~1' }; // git not available
	}
}

/**
 * Latest commit identity for the warning's evidence clause (issue #2818).
 * Only invoked when a warning is about to fire on the repository-wide path,
 * so it never adds subprocess cost to the in-scope / no-scope / unavailable
 * paths. Same bounded spawn discipline as the diff legs (issue #2236 shape),
 * routed through the `_internals` seam so the bounded-spawn suite keeps
 * counting every call.
 */
async function getLatestCommitShortSha(directory: string): Promise<string> {
	try {
		const gitExecutable = _internals.resolveGitExecutable();
		const proc = _internals.bunSpawn(
			[gitExecutable, 'rev-parse', '--short', 'HEAD'],
			{
				cwd: directory,
				...GIT_DIFF_SPAWN_OPTIONS,
			},
		);

		let exitCode: number;
		let stdout: string;
		try {
			[exitCode, stdout] = await Promise.all([proc.exited, proc.stdout.text()]);
		} finally {
			try {
				proc.kill();
			} catch {
				// Already exited — kill is a no-op.
			}
		}

		if (exitCode === 0) {
			const sha = stdout.trim();
			if (sha.length > 0 && !/\s/.test(sha)) return sha;
		}
		return '';
	} catch {
		return '';
	}
}

/**
 * Validate that git-changed files match the declared scope for a task.
 * Returns a warning string if undeclared files were modified, null otherwise.
 * Never throws.
 *
 * When `attribution.attributedFiles` is a non-empty array it is used as the
 * changed-file set (per-task truth) and no git command runs. Otherwise the
 * repository-wide diff is compared, and any warning names its evidence
 * (diff basis + latest commit) so mis-attribution is detectable.
 */
export async function validateDiffScope(
	taskId: string,
	directory: string,
	attribution?: DiffScopeAttribution,
): Promise<string | null> {
	try {
		const declaredScope = getDeclaredScope(taskId, directory);
		if (!declaredScope) return null; // No scope declared — skip

		// Normalise paths for comparison (forward slashes, no leading ./)
		const normalise = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
		const isSwarmPath = (p: string) => normalise(p).startsWith('.swarm/');
		const normScope = new Set(declaredScope.map(normalise));

		const attributed = attribution?.attributedFiles;
		let undeclared: string[];
		let evidence: string;

		if (Array.isArray(attributed) && attributed.length > 0) {
			// Per-task attribution record: compare the task's OWN files against
			// its declared scope; the repository-wide diff is not consulted.
			undeclared = attributed
				.filter((f) => typeof f === 'string' && f.length > 0)
				.filter((f) => !isSwarmPath(f))
				.map(normalise)
				.filter((f) => !normScope.has(f));
			evidence = 'task attribution record';
		} else {
			// No attribution record (legacy session / CLI / record released at
			// workflow-complete / evicted at the bounded cap): keep the
			// repository-wide comparison.
			const { files, basis } = await getChangedFiles(directory);
			if (!files) return null; // git unavailable — skip

			undeclared = files
				.filter((f) => !isSwarmPath(f))
				.map(normalise)
				.filter((f) => !normScope.has(f));

			if (undeclared.length === 0) return null;

			// A warning is about to fire — name the evidence so a reader can
			// detect a possible cross-task mis-attribution (issue #2818). The
			// generic no-sha wording retains "repository-wide" so the evidence
			// clause is recognisable even when rev-parse fails.
			const sha = await getLatestCommitShortSha(directory);
			const shaSuffix = sha ? ` ${sha}` : '';
			evidence =
				basis === 'HEAD'
					? `repository-wide uncommitted diff vs HEAD${shaSuffix}`
					: `repository-wide diff vs latest commit${shaSuffix}`;
		}

		if (undeclared.length === 0) return null;

		const scopeStr = declaredScope.join(', ');
		const undeclaredStr = undeclared.slice(0, 5).join(', ');
		const extra =
			undeclared.length > 5 ? ` (+${undeclared.length - 5} more)` : '';

		return `SCOPE WARNING: Task ${taskId} declared scope [${scopeStr}] but also modified [${undeclaredStr}${extra}] (evidence: ${evidence}). Reviewer should verify these changes are intentional.`;
	} catch {
		return null;
	}
}
