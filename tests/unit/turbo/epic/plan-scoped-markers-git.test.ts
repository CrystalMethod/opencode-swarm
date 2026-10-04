/**
 * Epic v2 C0 (B1) — plan-scoped Rule 2/Rule 3 markers against REAL git.
 *
 * A previous plan's `swarm(task 1.1):` marker must neither make the current
 * plan's 1.1 an idempotent skip (its work would never be committed) nor
 * satisfy Rule 3. Legacy (trailer-less) markers count only at/after the plan
 * root, and the root bound applies to trailer markers too. The root check is
 * per commit (never `git log --since`, whose walk stops at the first older
 * commit — reviewer M1), and records are NUL-separated so a message body
 * cannot forge one (reviewer L2).
 *
 * Commit times are pinned via GIT_COMMITTER_DATE literals relative to a
 * fixed plan root, so no clock is read by the test.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { _internals as gitBranchInternals } from '../../../../src/git/branch';
import {
	type PlanMarkerScope,
	readPlanScopedCommittedTaskIds,
} from '../../../../src/turbo/epic/plan-key';
import {
	_internals,
	commitTaskCompletion,
} from '../../../../src/turbo/epic/task-commit';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const KEY = 'c0c0c0c0c0c0c0c0';
const FOREIGN = 'f0f0f0f0f0f0f0f0';
const ROOT_SEC = 1_700_000_000;
const SCOPE: PlanMarkerScope = {
	planKey: KEY,
	rootTimestampMs: ROOT_SEC * 1000,
};
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

const originals = { ..._internals };
const gitExecOrig = gitBranchInternals.gitExec;
let dir: string;

function git(args: string[], dateSec?: number): string {
	const env: Record<string, string | undefined> = {
		...process.env,
		GIT_CONFIG_GLOBAL: NULL_DEVICE,
	};
	if (dateSec !== undefined) {
		env.GIT_COMMITTER_DATE = `@${dateSec} +0000`;
		env.GIT_AUTHOR_DATE = `@${dateSec} +0000`;
	}
	const r = spawnSync('git', args, {
		cwd: dir,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
		env,
	});
	if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
	return r.stdout;
}

function marker(taskId: string, dateSec: number, trailer?: string): void {
	const msg = `swarm(task ${taskId}): prior${trailer ? `\n\nSwarm-Plan: ${trailer}` : ''}`;
	git(['commit', '--allow-empty', '--no-verify', '-m', msg], dateSec);
}

function commitCount(): number {
	return Number.parseInt(git(['rev-list', '--count', 'HEAD']).trim(), 10);
}

beforeEach(() => {
	dir = canonicalMkdtemp('c0-plan-markers-');
	git(['init', '-q']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'user.name', 'Test User']);
	git(['config', 'commit.gpgsign', 'false']);
	git(['commit', '--allow-empty', '-m', 'seed'], ROOT_SEC - 10_000);
	_internals.sleep = async () => {};
});

afterEach(() => {
	Object.assign(_internals, originals);
	gitBranchInternals.gitExec = gitExecOrig;
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('Rule 2 idempotency is plan-scoped (real git)', () => {
	test('a foreign-plan marker with the same id is NOT honored: the current plan commits its own', async () => {
		marker('1.1', ROOT_SEC + 100, FOREIGN);
		const before = commitCount();
		const first = await commitTaskCompletion(
			dir,
			'1.1',
			'mine',
			undefined,
			SCOPE,
		);
		expect(first.reason).toBe('success');
		expect(commitCount()).toBe(before + 1);
		expect(git(['log', '-1', '--format=%B']).trim()).toBe(
			`swarm(task 1.1): mine\n\nSwarm-Plan: ${KEY}`,
		);
		// The current plan's own marker IS honored on a repeat completion.
		const again = await commitTaskCompletion(
			dir,
			'1.1',
			'mine',
			undefined,
			SCOPE,
		);
		expect(again).toMatchObject({ committed: true, reason: 'idempotent-skip' });
		expect(commitCount()).toBe(before + 1);
	});

	test('legacy (trailer-less) marker after the plan root is honored', async () => {
		marker('1.1', ROOT_SEC + 100);
		const r = await commitTaskCompletion(dir, '1.1', 'x', undefined, SCOPE);
		expect(r.reason).toBe('idempotent-skip');
	});

	test('legacy marker before the plan root is ignored', async () => {
		marker('1.1', ROOT_SEC - 100);
		const r = await commitTaskCompletion(dir, '1.1', 'x', undefined, SCOPE);
		expect(r.reason).toBe('success');
	});

	test('a trailer marker before the plan root is ignored (the root bound applies to trailer markers)', async () => {
		marker('1.1', ROOT_SEC - 100, KEY);
		const r = await commitTaskCompletion(dir, '1.1', 'x', undefined, SCOPE);
		expect(r.reason).toBe('success');
	});

	test('a throwing git log probe fails closed exactly as before: the commit proceeds', async () => {
		marker('1.1', ROOT_SEC + 100, KEY);
		gitBranchInternals.gitExec = ((args: string[], cwd: string) => {
			if (args[0] === 'log') throw new Error('git log timed out');
			return gitExecOrig(args, cwd);
		}) as typeof gitBranchInternals.gitExec;
		const before = commitCount();
		const r = await commitTaskCompletion(dir, '1.1', 'x', undefined, SCOPE);
		expect(r.reason).toBe('success');
		expect(commitCount()).toBe(before + 1);
	});
});

describe('marker reads survive skewed history and forged bodies (real git)', () => {
	test('M1: an old-dated commit on top of a valid marker does not hide it', async () => {
		marker('1.1', ROOT_SEC + 100, KEY);
		// Clock skew / `rebase --committer-date-is-author-date`: newest commit
		// carries a date before the plan root. `git log --since` would stop
		// walking here and never reach the marker beneath.
		git(['commit', '--allow-empty', '-m', 'skewed'], ROOT_SEC - 5_000);
		const r = await commitTaskCompletion(dir, '1.1', 'x', undefined, SCOPE);
		expect(r.reason).toBe('idempotent-skip');
		expect([...readPlanScopedCommittedTaskIds(dir, SCOPE, 10_000)]).toEqual([
			'1.1',
		]);
	});

	test('L2: a body embedding record/field separators cannot forge a marker', () => {
		// The quoted marker line makes the marker `--grep` select this commit;
		// with a `\x1e` record separator the embedded bytes would have been
		// parsed as a separate, honored `swarm(task 7.7)` record.
		const forged = `docs: notes\n\nswarm(task 9.9): quoted\n\x1e${ROOT_SEC + 50}\x1fswarm(task 7.7): forged\n\nSwarm-Plan: ${KEY}`;
		git(['commit', '--allow-empty', '-m', forged], ROOT_SEC + 60);
		marker('1.1', ROOT_SEC + 70, KEY);
		expect([...readPlanScopedCommittedTaskIds(dir, SCOPE, 10_000)]).toEqual([
			'1.1',
		]);
	});
});

describe('Rule 3 bulk read is plan-scoped (real git)', () => {
	test('only current-plan markers are evidence', () => {
		marker('1.1', ROOT_SEC - 50, KEY); // before root
		marker('1.2', ROOT_SEC - 40); // legacy before root
		marker('1.3', ROOT_SEC + 10, FOREIGN); // foreign plan
		marker('2.1', ROOT_SEC + 20); // legacy after root
		marker('2.2', ROOT_SEC + 30, KEY); // current plan
		const ids = readPlanScopedCommittedTaskIds(dir, SCOPE, 10_000);
		expect([...ids].sort()).toEqual(['2.1', '2.2']);
	});

	test('unknown plan root: only trailer markers of the current plan count', () => {
		marker('2.1', ROOT_SEC + 20);
		marker('2.2', ROOT_SEC + 30, KEY);
		const ids = readPlanScopedCommittedTaskIds(
			dir,
			{ planKey: KEY, rootTimestampMs: null },
			10_000,
		);
		expect([...ids]).toEqual(['2.2']);
	});
});
