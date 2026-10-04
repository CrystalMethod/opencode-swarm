/**
 * Rule 2 scope fidelity — regression coverage for the Epic catch-up review.
 * File: tests/unit/turbo/epic/task-commit-scope.test.ts
 *
 * Covers:
 *  - The marker commit is restricted to the task's scope (`--only`
 *    pathspec): a pre-staged unrelated file is NOT swept into it (real git).
 *  - No resolvable scope + dirty (non-.swarm) working tree → NO marker,
 *    structured `scope-unresolved` result (seam + real git).
 *  - No resolvable scope + `.swarm`-only changes → empty marker still written.
 *  - Large scopes switch to `--pathspec-from-file` (ARG_MAX / Windows cap)
 *    and the transient pathspec file is removed.
 *  - `parsePorcelainZPaths` handles rename records.
 *
 * Isolation: file-scoped `_internals` seams restored in `afterEach`
 * (AGENTS.md §7); real-git cases use a canonical temp repo (createSafeTestDir).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals as gitBranchInternals } from '../../../../src/git/branch';
import {
	_internals,
	commitTaskCompletion,
	parsePorcelainZPaths,
} from '../../../../src/turbo/epic/task-commit';
import { createSafeTestDir } from '../../../helpers/safe-test-dir';

/** Epic v2 C0: markers carry the plan's Swarm-Plan trailer. */
const TEST_MARKER_SCOPE = {
	planKey: 'feedfacecafebeef',
	rootTimestampMs: null,
};
const originals = { ..._internals };
const gitExecOrig = gitBranchInternals.gitExec;

afterEach(() => {
	Object.assign(_internals, originals);
	gitBranchInternals.gitExec = gitExecOrig;
});

function git(args: string[], cwd: string): string {
	const r = spawnSync('git', args, {
		cwd,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 30_000,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
	});
	if (r.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
	}
	return r.stdout;
}

function initRepo(dir: string): void {
	git(['init', '-q', '-b', 'main'], dir);
	git(['config', 'user.email', 'test@example.com'], dir);
	git(['config', 'user.name', 'Test User'], dir);
	git(['config', 'commit.gpgsign', 'false'], dir);
	fs.writeFileSync(path.join(dir, 'README.md'), '# seed\n');
	git(['add', 'README.md'], dir);
	git(['commit', '-q', '-m', 'seed'], dir);
}

function headFiles(dir: string): string[] {
	return git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], dir)
		.trim()
		.split('\n')
		.filter((l) => l.length > 0);
}

describe('Rule 2 — regression: marker commit swept the whole index (F-Rule2-pathspec)', () => {
	let dir: string;
	let cleanup: () => void;
	beforeEach(() => {
		({ dir, cleanup } = createSafeTestDir('rule2-pathspec-'));
		initRepo(dir);
		_internals.sleep = async () => {};
	});
	afterEach(() => cleanup());

	test('a pre-staged unrelated file stays staged and out of the scoped marker commit', async () => {
		// Previously `git commit --allow-empty --no-verify -m` ran with NO
		// pathspec, so whatever the user (or a sibling lane) had staged
		// landed inside this task's `swarm(task 2.1):` commit.
		fs.writeFileSync(path.join(dir, 'user-wip.txt'), 'staged by the user\n');
		git(['add', 'user-wip.txt'], dir);
		fs.mkdirSync(path.join(dir, 'src', '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'src', 'task.ts'), 'export {};\n');
		fs.writeFileSync(path.join(dir, 'src', '.swarm', 'x.json'), '{}');

		const result = await commitTaskCompletion(
			dir,
			'2.1',
			'desc',
			['src'],
			TEST_MARKER_SCOPE,
		);

		expect(result).toMatchObject({ committed: true, reason: 'success' });
		expect(git(['log', '-1', '--pretty=%s'], dir)).toMatch(
			/^swarm\(task 2\.1\):/,
		);
		expect(headFiles(dir)).toEqual(['src/task.ts']);
		expect(git(['status', '--porcelain', 'user-wip.txt'], dir)).toMatch(
			/^A {2}user-wip\.txt/,
		);
	});

	test('large scope (pathspec-from-file path) also keeps a pre-staged file out of the commit', async () => {
		fs.writeFileSync(path.join(dir, 'user-wip.txt'), 'staged by the user\n');
		git(['add', 'user-wip.txt'], dir);
		const scope: string[] = [];
		for (let i = 0; i < 700; i++) {
			const rel = `src/generated/module-with-a-long-name-${i}.ts`;
			scope.push(rel);
		}
		fs.mkdirSync(path.join(dir, 'src', 'generated'), { recursive: true });
		for (const rel of scope) fs.writeFileSync(path.join(dir, rel), 'x\n');

		const result = await commitTaskCompletion(
			dir,
			'2.3',
			'big',
			scope,
			TEST_MARKER_SCOPE,
		);

		expect(result).toMatchObject({ committed: true, reason: 'success' });
		expect(headFiles(dir)).toHaveLength(700);
		expect(headFiles(dir)).not.toContain('user-wip.txt');
		expect(git(['status', '--porcelain', 'user-wip.txt'], dir)).toMatch(
			/^A {2}user-wip\.txt/,
		);
		// The transient pathspec file under the git dir is gone.
		const gitDir = path.join(dir, '.git');
		expect(
			fs.readdirSync(gitDir).filter((f) => f.startsWith('swarm-rule2-')),
		).toEqual([]);
	});

	test('regression: a new file in a new nested dir under a tracked dir is staged and committed', async () => {
		// Previously staging ran `git add -- <file> :(exclude,glob)**/.swarm/**`;
		// on git 2.43 that exited 0 while staging NOTHING for this shape, so
		// the task's new file silently never reached its commit.
		fs.mkdirSync(path.join(dir, 'trk'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'trk', 't.ts'), 'tracked\n');
		git(['add', 'trk/t.ts'], dir);
		git(['commit', '-q', '-m', 'track trk'], dir);
		fs.mkdirSync(path.join(dir, 'trk', 'n2', 'n3'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'trk', 'n2', 'n3', 'f.ts'), 'new\n');
		fs.mkdirSync(path.join(dir, 'trk', 'n2', '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'trk', 'n2', '.swarm', 'x.json'), '{}');

		const result = await commitTaskCompletion(
			dir,
			'2.4',
			'nested',
			['trk/n2/n3/f.ts', 'trk/n2'],
			TEST_MARKER_SCOPE,
		);

		expect(result).toMatchObject({ committed: true, reason: 'success' });
		expect(headFiles(dir)).toEqual(['trk/n2/n3/f.ts']);
	});

	test('no-scope marker on a .swarm-only dirty tree is an empty commit', async () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(dir, '.swarm', 'plan.json'), '{}');
		const result = await commitTaskCompletion(
			dir,
			'2.2',
			'verify only',
			undefined,
			TEST_MARKER_SCOPE,
		);
		expect(result).toMatchObject({ committed: true, reason: 'success' });
		expect(headFiles(dir)).toEqual([]);
	});
});

describe('Rule 2 — regression: unresolvable scope wrote a marker over uncommitted work (F-Rule2-noscope)', () => {
	test('real git: dirty tree + no scope → no marker, changes left in place', async () => {
		// Previously a missing/expired scope binding produced an
		// `--allow-empty` marker while the task's changes stayed unstaged;
		// Rule 3 then treated the task as committed.
		const { dir, cleanup } = createSafeTestDir('rule2-noscope-');
		try {
			initRepo(dir);
			fs.writeFileSync(path.join(dir, 'README.md'), '# edited by task\n');
			const head = git(['rev-parse', 'HEAD'], dir).trim();

			const result = await commitTaskCompletion(
				dir,
				'3.1',
				'desc',
				undefined,
				TEST_MARKER_SCOPE,
			);

			expect(result.committed).toBe(false);
			expect(result.reason).toBe('scope-unresolved');
			expect(result.error).toContain('declare_scope');
			expect(result.error).toContain('README.md');
			expect(git(['rev-parse', 'HEAD'], dir).trim()).toBe(head);
			expect(git(['status', '--porcelain'], dir)).toContain('README.md');
		} finally {
			cleanup();
		}
	});

	test('seam: status read failure is treated as unknown → no marker (fail-closed)', async () => {
		_internals.isGitRepo = () => true;
		_internals.hasExistingTaskCommit = () => false;
		_internals.listChangedPaths = () => {
			throw new Error('status exploded');
		};
		let committed = false;
		_internals.commitScopedPaths = () => {
			committed = true;
		};
		const result = await commitTaskCompletion(
			'/tmp/fake',
			'3.2',
			'desc',
			undefined,
			TEST_MARKER_SCOPE,
		);
		expect(result.reason).toBe('scope-unresolved');
		expect(result.error).toContain('status exploded');
		expect(committed).toBe(false);
	});

	test('seam: only magic-pathspec scope entries count as unresolved scope', async () => {
		_internals.isGitRepo = () => true;
		_internals.hasExistingTaskCommit = () => false;
		_internals.listChangedPaths = () => ['src/a.ts'];
		_internals.commitScopedPaths = () => {
			throw new Error('must not commit');
		};
		const result = await commitTaskCompletion(
			'/tmp/fake',
			'3.3',
			'desc',
			[':(glob)**'],
			TEST_MARKER_SCOPE,
		);
		expect(result.reason).toBe('scope-unresolved');
	});

	test('seam: nested and root .swarm paths do not count as dirty', async () => {
		_internals.isGitRepo = () => true;
		_internals.hasExistingTaskCommit = () => false;
		_internals.listChangedPaths = () => [
			'.swarm/',
			'.swarm/plan.json',
			'packages/foo/.swarm/x.json',
		];
		const committedPaths: string[][] = [];
		_internals.commitScopedPaths = (_c, _m, paths) => {
			committedPaths.push(paths);
		};
		_internals.gitHeadSha = () => 'sha';
		const result = await commitTaskCompletion(
			'/tmp/fake',
			'3.4',
			'desc',
			undefined,
			TEST_MARKER_SCOPE,
		);
		expect(result).toMatchObject({ committed: true, reason: 'success' });
		expect(committedPaths).toEqual([[]]);
	});
});

describe('commitScopedPaths argv', () => {
	test('small file lists are passed inline after `--` as literal pathspecs; .swarm entries are dropped', () => {
		const argvs: string[][] = [];
		gitBranchInternals.gitExec = ((args: string[]) => {
			argvs.push([...args]);
			return '';
		}) as typeof gitBranchInternals.gitExec;
		originals.commitScopedPaths('/tmp/fake', 'swarm(task 1.1): x', [
			'src/a.ts',
			'src/.swarm/leak.json',
		]);
		expect(argvs).toEqual([
			[
				'commit',
				'--allow-empty',
				'--only',
				'--no-verify',
				'-m',
				'swarm(task 1.1): x',
				'--',
				':(literal)src/a.ts',
			],
		]);
	});

	test('large scopes use a NUL-delimited --pathspec-from-file that is removed afterwards', () => {
		const { dir, cleanup } = createSafeTestDir('rule2-pathspec-file-');
		try {
			const specPath = path.join(dir, 'spec');
			let seenSpec: string | null = null;
			let commitArgv: string[] = [];
			gitBranchInternals.gitExec = ((args: string[]) => {
				if (args[0] === 'rev-parse') return `${specPath}\n`;
				commitArgv = [...args];
				seenSpec = fs.readFileSync(specPath, 'utf-8');
				return '';
			}) as typeof gitBranchInternals.gitExec;
			const paths = Array.from(
				{ length: 1000 },
				(_, i) => `src/deeply/nested/module-${i}/file.ts`,
			);
			originals.commitScopedPaths(dir, 'swarm(task 9.9): big', paths);
			expect(commitArgv).toContain(`--pathspec-from-file=${specPath}`);
			expect(commitArgv).toContain('--pathspec-file-nul');
			expect(commitArgv).toContain('--only');
			expect(commitArgv).not.toContain('--');
			const entries = (seenSpec ?? '').split('\0').filter((e) => e);
			expect(entries).toHaveLength(1000);
			expect(entries[0]).toBe(':(literal)src/deeply/nested/module-0/file.ts');
			expect(fs.existsSync(specPath)).toBe(false);
		} finally {
			cleanup();
		}
	});
});

describe('parsePorcelainZPaths', () => {
	test('returns both paths of a rename record and plain entries', () => {
		const out = 'R  new.ts\0old.ts\0 M src/a.ts\0?? .swarm/\0';
		expect(parsePorcelainZPaths(out)).toEqual([
			'new.ts',
			'old.ts',
			'src/a.ts',
			'.swarm/',
		]);
	});

	test('empty output → no paths', () => {
		expect(parsePorcelainZPaths('')).toEqual([]);
	});
});

describe('stageScopedPaths (real) — staging argv', () => {
	beforeEach(() => {
		_internals.sleep = async () => {};
		_internals.listChangedPaths = () => [];
	});

	test('stageScopedPaths (real) filters .swarm at any depth in JS and stages with literal pathspecs, never exclude magic (AGENTS.md #4)', async () => {
		// Stubs the LOWER seam (`gitBranchInternals.gitExec`) and exercises
		// the REAL `stageScopedPaths` + `commitScopedPaths`. `.swarm` paths
		// discovered under the scope must never be staged or committed, and
		// no `git add` may carry an `:(exclude...)` pathspec (git 2.43
		// silently stages nothing for some new nested files with it).
		const gitOrig = gitBranchInternals.gitExec;
		const capturedArgvs: string[][] = [];
		gitBranchInternals.gitExec = ((args: string[], _cwd: string) => {
			capturedArgvs.push([...args]);
			if (args[0] === 'log') return '';
			if (args[0] === 'rev-parse') return 'abc1234';
			if (args[0] === 'ls-files') {
				return 'pkg/foo.ts\0pkg/.swarm/leak.json\0.swarm/plan.json\0';
			}
			if (args[0] === 'diff') return 'pkg/foo.ts\0pkg/.swarm/leak.json\0';
			return '';
		}) as typeof gitBranchInternals.gitExec;

		try {
			_internals.isGitRepo = () => true;
			_internals.stageScopedPaths = originals.stageScopedPaths;
			_internals.commitScopedPaths = originals.commitScopedPaths;
			_internals.gitHeadSha = originals.gitHeadSha;
			_internals.hasExistingTaskCommit = originals.hasExistingTaskCommit;

			await commitTaskCompletion(
				'/tmp/fake',
				'2.1',
				'desc',
				['pkg'],
				TEST_MARKER_SCOPE,
			);

			const lsArgv = capturedArgvs.find((a) => a[0] === 'ls-files');
			expect(lsArgv).toEqual([
				'ls-files',
				'-z',
				'--others',
				'--modified',
				'--exclude-standard',
				'--',
				':(literal)pkg',
			]);
			const addArgvs = capturedArgvs.filter((a) => a[0] === 'add');
			expect(addArgvs).toEqual([['add', '-A', '--', ':(literal)pkg/foo.ts']]);
			const commitArgv = capturedArgvs.find((a) => a[0] === 'commit');
			expect(commitArgv?.slice(-2)).toEqual(['--', ':(literal)pkg/foo.ts']);
			expect(
				capturedArgvs.some((a) => a.some((t) => t.includes(':(exclude'))),
			).toBe(false);
		} finally {
			gitBranchInternals.gitExec = gitOrig;
		}
	});

	test('Phase 17 (E.3): scopes larger than CHUNK get split into multiple ls-files / add / diff invocations', async () => {
		_internals.isGitRepo = () => true;
		_internals.stageScopedPaths = originals.stageScopedPaths;
		const { _internals: gbi } = await import('../../../../src/git/branch');
		const gitOrig = gbi.gitExec;
		const counts: Record<string, number[]> = {
			'ls-files': [],
			add: [],
			diff: [],
		};
		gbi.gitExec = ((args: string[]) => {
			const sep = args.indexOf('--');
			const pathCount = sep >= 0 ? args.length - sep - 1 : 0;
			if (args[0] in counts) counts[args[0]].push(pathCount);
			if (args[0] === 'ls-files') {
				// Every scope path is "discovered" as changed.
				return `${args.slice(sep + 1).join('\0')}\0`;
			}
			return '';
		}) as typeof gbi.gitExec;
		_internals.commitScopedPaths = () => {};
		_internals.gitHeadSha = () => 'sha';
		_internals.hasExistingTaskCommit = () => false;

		try {
			const manyPaths = Array.from({ length: 450 }, (_, i) => `src/f${i}.ts`);
			await commitTaskCompletion(
				'/tmp/fake',
				'3.1',
				'desc',
				manyPaths,
				TEST_MARKER_SCOPE,
			);
			// 450 paths / chunk size 200 → 3 invocations (200 + 200 + 50).
			expect(counts['ls-files']).toEqual([200, 200, 50]);
			expect(counts.add).toEqual([200, 200, 50]);
			expect(counts.diff).toEqual([200, 200, 50]);
		} finally {
			gbi.gitExec = gitOrig;
		}
	});
});
