import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir.js';
import { _internals, validateDiffScope } from './diff-scope';

/**
 * Issue #2818 — per-task attribution sourcing for the SCOPE WARNING.
 *
 * validateDiffScope previously compared a task's declared scope against the
 * repository-wide `git diff HEAD~1` — the repo's latest commit, which may
 * belong to a DIFFERENT task — mis-attributing that task's files to whichever
 * task update_task_status was checking. These tests pin the fix: the session's
 * task-keyed attribution record (`modifiedFilesByTask`) is used as the
 * changed-file set when supplied (zero git spawns), and the legacy
 * repository-wide warning names its evidence (diff basis + latest commit).
 */

function mkTempDir(): string {
	return canonicalMkdtemp('diff-scope-2818-');
}

async function run(
	cmd: string[],
	cwd: string,
): Promise<{ exitCode: number; stdout: string }> {
	const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
	const [exitCode, stdout] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
	]);
	return { exitCode, stdout };
}

async function gitInit(cwd: string): Promise<void> {
	await run(['git', 'init'], cwd);
	await run(['git', 'config', 'user.email', 'test@test.com'], cwd);
	await run(['git', 'config', 'user.name', 'Test'], cwd);
	fs.writeFileSync(path.join(cwd, 'dummy.txt'), 'initial');
	await run(['git', 'add', '.'], cwd);
	await run(['git', 'commit', '-m', 'initial'], cwd);
}

/** Write + commit one file; returns nothing. */
async function commitFile(cwd: string, file: string): Promise<void> {
	const fullPath = path.join(cwd, file);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, `content of ${file}`);
	await run(['git', 'add', file], cwd);
	await run(['git', 'commit', '-m', `add ${file}`], cwd);
}

/** Stage a file WITHOUT committing (shows up in `git diff HEAD`, not HEAD~1). */
async function stageFile(cwd: string, file: string): Promise<void> {
	const fullPath = path.join(cwd, file);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, `content of ${file}`);
	await run(['git', 'add', file], cwd);
}

function createPlanJson(
	cwd: string,
	tasks: Array<{
		id: string;
		files_touched?: string | string[];
	}>,
): void {
	const plan = { phases: [{ id: '1', name: 'Phase 1', tasks }] };
	fs.mkdirSync(path.join(cwd, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

/**
 * Two-task fixture matching the reported shape: task 1.1 committed src/a.ts,
 * then the CONCURRENT task 3.4 committed src/b.ts as the repo's latest
 * commit. Task 3.4 declares src/b.ts in its own scope; task 1.1 declares
 * src/a.ts.
 */
async function twoTaskFixture(cwd: string): Promise<void> {
	await gitInit(cwd);
	await commitFile(cwd, 'src/a.ts');
	await commitFile(cwd, 'src/b.ts');
	createPlanJson(cwd, [
		{ id: '1.1', files_touched: ['src/a.ts'] },
		{ id: '3.4', files_touched: ['src/b.ts'] },
	]);
}

describe('validateDiffScope per-task attribution (#2818)', () => {
	let tmpDirToClean: string | undefined;

	afterEach(() => {
		if (tmpDirToClean) {
			try {
				fs.rmSync(tmpDirToClean, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
			tmpDirToClean = undefined;
		}
	});

	test('AC1: attributed files all in scope — foreign latest commit produces NO warning', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await twoTaskFixture(dir);

		// Base behaviour: repository-wide diff names src/b.ts (task 3.4's file).
		const legacy = await validateDiffScope('1.1', dir);
		expect(legacy).not.toBeNull();
		expect(legacy!.includes('src/b.ts')).toBe(true);

		// With the task's own attribution record: no warning.
		const result = await validateDiffScope('1.1', dir, {
			attributedFiles: ['src/a.ts'],
		});
		expect(result).toBeNull();
	});

	test('AC2: attributed out-of-scope file is named by the warning', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await twoTaskFixture(dir);

		// src/x.ts exists only in the attribution record — it was modified in
		// an earlier commit, outside the repo-wide HEAD~1 window.
		const result = await validateDiffScope('1.1', dir, {
			attributedFiles: ['src/a.ts', 'src/x.ts'],
		});
		expect(result).not.toBeNull();
		expect(result!.includes('src/x.ts')).toBe(true);
		expect(result!.includes('task attribution record')).toBe(true);
		// The foreign task's file must not be attributed to task 1.1.
		expect(result!.includes('src/b.ts')).toBe(false);
	});

	test('AC3: no attribution — legacy warning names repository-wide evidence + commit', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await twoTaskFixture(dir);

		const result = await validateDiffScope('1.1', dir);
		expect(result).not.toBeNull();
		expect(result!.includes('src/b.ts')).toBe(true);
		expect(result!.includes('repository-wide diff vs latest commit')).toBe(
			true,
		);
		const { stdout } = await run(['git', 'rev-parse', '--short', 'HEAD'], dir);
		expect(result!.includes(stdout.trim())).toBe(true);
	});

	test('AC3b: no attribution, single-commit repo (HEAD leg) — evidence names the uncommitted basis', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await gitInit(dir);
		await stageFile(dir, 'src/staged.ts');
		createPlanJson(dir, [{ id: '2.1', files_touched: ['src/other.ts'] }]);

		const result = await validateDiffScope('2.1', dir);
		expect(result).not.toBeNull();
		expect(result!.includes('src/staged.ts')).toBe(true);
		expect(result!.includes('repository-wide uncommitted diff vs HEAD')).toBe(
			true,
		);
	});

	test('AC5a: task without declared scope — null even with attribution', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await twoTaskFixture(dir);
		createPlanJson(dir, [{ id: '9.9' }]);

		const result = await validateDiffScope('9.9', dir, {
			attributedFiles: ['src/a.ts'],
		});
		expect(result).toBeNull();
	});

	test('AC5b: missing plan.json — null', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await gitInit(dir);

		const result = await validateDiffScope('1.1', dir, {
			attributedFiles: ['src/a.ts'],
		});
		expect(result).toBeNull();
	});

	test('AC5c: genuine violation with no attribution still warns (advisory preserved)', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await twoTaskFixture(dir);

		const result = await validateDiffScope('1.1', dir);
		expect(result).not.toBeNull();
		expect(result!.includes('SCOPE WARNING')).toBe(true);
		expect(
			result!.includes('Reviewer should verify these changes are intentional.'),
		).toBe(true);
	});

	test('AC6: attribution containing only .swarm paths stays filtered to null', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await twoTaskFixture(dir);
		createPlanJson(dir, [{ id: '4.1', files_touched: ['src/a.ts'] }]);

		const result = await validateDiffScope('4.1', dir, {
			attributedFiles: ['.swarm/plan.json', '.swarm/evidence/x.json'],
		});
		expect(result).toBeNull();
	});

	test('zero git spawns when per-task attribution is supplied', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await twoTaskFixture(dir);
		createPlanJson(dir, [{ id: '1.1', files_touched: ['src/a.ts'] }]);

		const originalBunSpawn = _internals.bunSpawn;
		let spawnCalls = 0;
		_internals.bunSpawn = (() => {
			spawnCalls += 1;
			throw new Error('git must not be consulted on the attribution path');
		}) as typeof _internals.bunSpawn;
		try {
			const result = await validateDiffScope('1.1', dir, {
				attributedFiles: ['src/a.ts'],
			});
			expect(result).toBeNull();
			expect(spawnCalls).toBe(0);
		} finally {
			_internals.bunSpawn = originalBunSpawn;
		}
	});

	test('wiring: checkReviewerGateWithScope passes session-derived attribution to validateDiffScope', () => {
		const source = fs.readFileSync(
			path.join(import.meta.dir, '..', 'tools', 'update-task-status.ts'),
			'utf-8',
		);
		const gateIdx = source.indexOf(
			'export async function checkReviewerGateWithScope',
		);
		expect(gateIdx).toBeGreaterThan(-1);
		const callIdx = source.indexOf('validateDiffScope(', gateIdx);
		expect(callIdx).toBeGreaterThan(-1);

		// Balanced-paren close of the call (biome-reflow stable, same approach
		// as the frozen acceptance probe c4-wiring.ts).
		let depth = 0;
		let end = -1;
		for (let i = callIdx + 'validateDiffScope'.length; i < source.length; i++) {
			const ch = source[i];
			if (ch === '(') depth++;
			else if (ch === ')') {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		expect(end).toBeGreaterThan(-1);

		const windowLines = source
			.slice(0, end + 1)
			.split('\n')
			.slice(-8);
		const window = windowLines.join('\n');
		expect(
			/attributionFiles|attributedFiles|modifiedFilesByTask|getModifiedFilesForTask/.test(
				window,
			),
		).toBe(true);
		expect(window.includes('sessionID')).toBe(true);
	});
});
