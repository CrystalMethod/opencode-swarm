/**
 * Tests for greenfield-smart Rule 3 — `buildIsUpstreamCommittedWithStatus`.
 * File: tests/unit/turbo/epic/upstream-commits.test.ts
 *
 * Epic v2 C0: the predicate honors only markers that belong to the CURRENT
 * plan (matching `Swarm-Plan:` trailer, or a legacy trailer-less marker
 * committed at/after the plan root). Verifies:
 *  - parses task ids from `swarm(task <id>):` subjects, honoring plan scope;
 *  - any evidence-read failure (no plan, plan identity, git) sets
 *    `gitFailed` so callers fail closed;
 *  - the bulk read is ONE bounded `git log -z` call (`--max-count`, no
 *    `--since`: the plan-root check is per record);
 *  - the Phase 6 plan-ledger fallback stays removed.
 *
 * Test isolation: `_internals` DI seams only (AGENTS.md #7), restored in
 * `afterEach`. Commit times are numeric literals — no clock reads.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../../src/config/plan-schema';
import { _internals as gitBranchInternals } from '../../../../src/git/branch';
import type { PlanMarkerScope } from '../../../../src/turbo/epic/plan-key';
import {
	_internals,
	buildIsUpstreamCommittedWithStatus,
} from '../../../../src/turbo/epic/upstream-commits';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const KEY = 'aaaaaaaaaaaaaaaa';
const FOREIGN = 'bbbbbbbbbbbbbbbb';
const ROOT_SEC = 1_700_000_000;
const SCOPE: PlanMarkerScope = {
	planKey: KEY,
	rootTimestampMs: ROOT_SEC * 1000,
};

const PLAN = {
	schema_version: '1.0.0',
	title: 'Upstream Plan',
	swarm: 'test-swarm',
	current_phase: 1,
	migration_status: 'native',
	phases: [{ id: 1, name: 'P1', status: 'pending', tasks: [] }],
} as unknown as Plan;

/** One `git log -z --format=%ct%x1f%B` record (NUL-terminated). */
function rec(ct: number, subject: string, trailer?: string): string {
	return `${ct}\x1f${subject}\n${trailer ? `\nSwarm-Plan: ${trailer}\n` : ''}\n\0`;
}

const originals = { ..._internals };
const gitExecOrig = gitBranchInternals.gitExec;

afterEach(() => {
	Object.assign(_internals, originals);
	gitBranchInternals.gitExec = gitExecOrig;
});

function stubLog(output: string, argvSink?: string[][]): void {
	_internals.resolvePlanMarkerScope = async () => SCOPE;
	gitBranchInternals.gitExec = ((args: string[]) => {
		argvSink?.push([...args]);
		return output;
	}) as typeof gitBranchInternals.gitExec;
}

describe('buildIsUpstreamCommittedWithStatus — plan-scoped markers', () => {
	test('honors current-plan trailer markers and in-window legacy markers only', async () => {
		stubLog(
			[
				rec(ROOT_SEC + 10, 'swarm(task 1.1): set up package', KEY),
				rec(ROOT_SEC + 20, 'swarm(task 1.2): foreign plan', FOREIGN),
				rec(ROOT_SEC + 30, 'swarm(task 2.1): legacy, after root'),
				rec(ROOT_SEC - 1, 'swarm(task 2.2): legacy, before root'),
				rec(ROOT_SEC - 1, 'swarm(task 2.3): trailer, before root', KEY),
				rec(ROOT_SEC + 40, 'feat: unrelated commit'),
			].join(''),
		);
		const evidence = await buildIsUpstreamCommittedWithStatus('/x', PLAN);
		expect(evidence.gitFailed).toBe(false);
		expect(evidence.predicate('1.1')).toBe(true);
		expect(evidence.predicate('1.2')).toBe(false);
		expect(evidence.predicate('2.1')).toBe(true);
		expect(evidence.predicate('2.2')).toBe(false);
		expect(evidence.predicate('2.3')).toBe(false);
		expect(evidence.predicate('feat')).toBe(false);
	});

	test('root unknown: legacy markers are never honored', async () => {
		const argv: string[][] = [];
		stubLog(
			[
				rec(ROOT_SEC, 'swarm(task 1.1): legacy'),
				rec(ROOT_SEC, 'swarm(task 1.2): mine', KEY),
			].join(''),
			argv,
		);
		_internals.resolvePlanMarkerScope = async () => ({
			planKey: KEY,
			rootTimestampMs: null,
		});
		const evidence = await buildIsUpstreamCommittedWithStatus('/x', PLAN);
		expect(evidence.predicate('1.1')).toBe(false);
		expect(evidence.predicate('1.2')).toBe(true);
		expect(argv[0].some((a) => a.startsWith('--since='))).toBe(false);
	});

	test('one bounded git log -z call: --no-merges, default --max-count=10000, never --since', async () => {
		const argv: string[][] = [];
		stubLog('', argv);
		await buildIsUpstreamCommittedWithStatus('/x', PLAN);
		expect(argv).toHaveLength(1);
		expect(argv[0][0]).toBe('log');
		expect(argv[0]).toContain('-z');
		expect(argv[0].some((a) => a.startsWith('--since'))).toBe(false);
		expect(argv[0]).toContain('--no-merges');
		expect(argv[0]).toContain('--max-count=10000');
		expect(argv[0]).toContain('--grep=^swarm\\(task [^)]+\\):');
	});

	test('custom maxCommits reaches the git log invocation', async () => {
		const argv: string[][] = [];
		stubLog('', argv);
		await buildIsUpstreamCommittedWithStatus('/x', PLAN, { maxCommits: 42 });
		expect(argv[0]).toContain('--max-count=42');
	});

	test('git failure → gitFailed (callers fail closed) with a reason', async () => {
		_internals.resolvePlanMarkerScope = async () => SCOPE;
		gitBranchInternals.gitExec = (() => {
			throw new Error('git timed out');
		}) as typeof gitBranchInternals.gitExec;
		const evidence = await buildIsUpstreamCommittedWithStatus('/x', PLAN);
		expect(evidence.gitFailed).toBe(true);
		expect(evidence.failureReason).toContain('git timed out');
	});

	test('plan identity resolution failure → gitFailed without touching git', async () => {
		let gitCalled = false;
		gitBranchInternals.gitExec = (() => {
			gitCalled = true;
			return '';
		}) as typeof gitBranchInternals.gitExec;
		_internals.resolvePlanMarkerScope = async () => {
			throw new Error('Conflicting plan epoch metadata');
		};
		const evidence = await buildIsUpstreamCommittedWithStatus('/x', PLAN);
		expect(evidence.gitFailed).toBe(true);
		expect(evidence.failureReason).toContain('Conflicting plan epoch');
		expect(gitCalled).toBe(false);
	});

	test('no plan → gitFailed', async () => {
		const evidence = await buildIsUpstreamCommittedWithStatus('/x', null);
		expect(evidence.gitFailed).toBe(true);
	});

	test('Phase 6 regression: plan-ledger fallback stays GONE — plan.json "completed" is not evidence', async () => {
		const dir = canonicalMkdtemp('upstream-no-fallback-');
		try {
			fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(dir, '.swarm', 'plan.json'),
				JSON.stringify({
					phases: [{ id: 1, tasks: [{ id: '1.1', status: 'completed' }] }],
				}),
			);
			stubLog('');
			const evidence = await buildIsUpstreamCommittedWithStatus(dir, PLAN);
			expect(evidence.predicate('1.1')).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
