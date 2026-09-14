import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	FrozenTaskSetMismatchError,
	freezeHarnessOptTaskSet,
	harnessOptStatus,
	runHarnessOptRound,
	stopHarnessOptLoop,
} from '../../../src/services/harness-optimizer/controller.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let root = '';

beforeEach(() => {
	root = canonicalMkdtemp('harnessopt-controller-');
	writeFileSync(path.join(root, 'README.md'), 'fixture\n');
	for (const args of [
		['init'],
		['add', '.'],
		[
			'-c',
			'user.name=Test',
			'-c',
			'user.email=test@example.invalid',
			'commit',
			'-m',
			'fixture',
		],
	]) {
		execFileSync('git', args, { cwd: root, timeout: 30_000, stdio: 'ignore' });
	}
});

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

const tasks = [
	{ id: 'round-task', instruction: 'reply with {"v":1,"caught":true}' },
];
const okExecutor = async () => ({
	status: 'completed' as const,
	text: '{"v":1,"caught":true}',
});

describe('freezeHarnessOptTaskSet', () => {
	test('freezes idempotently and rejects mutated re-freeze', async () => {
		const first = await freezeHarnessOptTaskSet({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'freeze-seed',
		});
		expect(first.ok).toBe(true);
		const second = await freezeHarnessOptTaskSet({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'freeze-seed',
		});
		expect(second.ok && second.contentHash).toBe(
			first.ok ? first.contentHash : undefined,
		);
		const mutated = await freezeHarnessOptTaskSet({
			projectRoot: root,
			tasks: [{ id: 'round-task', instruction: 'MUTATED' }],
			split: 'validation',
			seed: 'freeze-seed',
		});
		expect(mutated.ok).toBe(false);
	});

	test('a different seed key freezes independently', async () => {
		await freezeHarnessOptTaskSet({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'seed-one',
		});
		const other = await freezeHarnessOptTaskSet({
			projectRoot: root,
			tasks: [{ id: 'round-task', instruction: 'DIFFERENT' }],
			split: 'validation',
			seed: 'seed-two',
		});
		expect(other.ok).toBe(true);
	});
});

describe('runHarnessOptRound', () => {
	test('runs a governed round; a neutral round stops inconclusive (no deadband crossing)', async () => {
		const result = await runHarnessOptRound({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'round-seed',
			executor: okExecutor,
		});
		// Identical baseline/candidate scores leave the paired delta inside
		// the deadband, so the substrate decision — and the mapped stop
		// reason — are inconclusive, never 'completed'.
		expect(result.stopReason).toBe('inconclusive');
		expect(result.decision.status).toBeString();
		expect(result.roundCounter).toBe(1);
		expect(result.saltedSeed).toBe('round-seed#round000001');
	});

	test('transient failures exhaust exactly the configured retry bound', async () => {
		const result = await runHarnessOptRound({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'transient-seed',
			maxTransientRetries: 2,
			executor: async () => ({ status: 'transient_error', text: '' }),
		});
		expect(result.stopReason).toBe('transient_retry_budget_exhausted');
		expect(result.transientRetries).toBe(2);
	});

	test('a second held-out round over the same frozen set is refused by the substrate', async () => {
		await runHarnessOptRound({
			projectRoot: root,
			tasks,
			split: 'test',
			seed: 'heldout-seed',
			executor: okExecutor,
		});
		let caught: unknown;
		try {
			await runHarnessOptRound({
				projectRoot: root,
				tasks,
				split: 'test',
				seed: 'heldout-seed',
				executor: okExecutor,
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeDefined();
		const name = (caught as { name?: string }).name ?? '';
		const message = caught instanceof Error ? caught.message : String(caught);
		expect(
			name === 'TestAlreadyConsumedError' ||
				/already[- ]?consumed|held[- ]?out/i.test(`${name} ${message}`),
		).toBe(true);
	});

	test('mutated frozen content fails typed before execution', async () => {
		await freezeHarnessOptTaskSet({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'mismatch-seed',
		});
		await expect(
			runHarnessOptRound({
				projectRoot: root,
				tasks: [{ id: 'round-task', instruction: 'MUTATED' }],
				split: 'validation',
				seed: 'mismatch-seed',
				executor: okExecutor,
			}),
		).rejects.toBeInstanceOf(FrozenTaskSetMismatchError);
	});
});

describe('budget enforcement (final-critic revision)', () => {
	test('a round exceeding its wall-clock budget stops wall_clock_budget_exhausted', async () => {
		const result = await runHarnessOptRound({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'wall-clock-seed',
			maxWallClockMs: 1,
			executor: async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				return { status: 'completed', text: '{"v":1,"caught":true}' };
			},
		});
		expect(result.stopReason).toBe('wall_clock_budget_exhausted');
	});

	test('a round exceeding its spend budget stops spend_budget_exhausted', async () => {
		const result = await runHarnessOptRound({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'spend-seed',
			maxSpendUsd: 0.5,
			executor: async () => ({
				status: 'completed' as const,
				text: '{"v":1,"caught":true}',
				costUsd: 1,
			}),
		});
		expect(result.stopReason).toBe('spend_budget_exhausted');
	});

	test('a tampered materialized input fails typed before execution', async () => {
		const { HarnessOptInputTamperedError } = await import(
			'../../../src/services/harness-optimizer/execution.js'
		);
		await runHarnessOptRound({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'tamper-seed',
			executor: okExecutor,
		});
		const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
		const instructionPath = path.join(
			root,
			'.swarm',
			'evolution',
			'harness-opt',
			'tasksets',
			// the single frozen task set for this project root so far
			...(
				(await import('node:fs')).readdirSync(
					path.join(root, '.swarm', 'evolution', 'harness-opt', 'tasksets'),
				) as string[]
			).map((dir) => dir),
			'round-task',
			'instruction.md',
		);
		const original = rf(instructionPath, 'utf8');
		wf(instructionPath, 'TAMPERED INSTRUCTION' + String.fromCharCode(10));
		await expect(
			runHarnessOptRound({
				projectRoot: root,
				tasks,
				split: 'validation',
				seed: 'tamper-seed',
				executor: okExecutor,
			}),
		).rejects.toBeInstanceOf(HarnessOptInputTamperedError);
		wf(instructionPath, original);
	});
});

describe('stop and status', () => {
	test('operator stop halts rounds until cleared (typed stop, no consumption)', async () => {
		await runHarnessOptRound({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'pre-stop-seed',
			executor: okExecutor,
		});
		await stopHarnessOptLoop({ projectRoot: root, reason: 'operator halt' });
		const status = harnessOptStatus(root);
		expect(status.stopped).toBe(true);
		expect(status.stopReason).toBe('operator halt');
		const stopped = await runHarnessOptRound({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'stopped-seed',
			executor: okExecutor,
		});
		expect(stopped.stopReason).toBe('stopped_by_operator');
		// No round was executed for the stopped seed: the counter is unchanged
		// from the pre-stop round.
		expect(stopped.roundCounter).toBe(1);
		expect(stopped.decision.decisionId).toBe('');

		// Resume (PRR-C01): the advertised recovery path must actually clear
		// the stop so governed rounds run again.
		const { resumeHarnessOptLoop } = await import(
			'../../../src/services/harness-optimizer/controller.js'
		);
		const resumed = await resumeHarnessOptLoop({ projectRoot: root });
		expect(resumed.resumed).toBe(true);
		expect(resumed.previousReason).toBe('operator halt');
		const afterResume = await runHarnessOptRound({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'resumed-seed',
			executor: okExecutor,
		});
		expect(afterResume.stopReason).toBe('inconclusive');
		expect(afterResume.roundCounter).toBe(2);
	});

	test('status reports the round counter and frozen task sets', async () => {
		await runHarnessOptRound({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'status-seed',
			executor: okExecutor,
		});
		const status = harnessOptStatus(root);
		expect(status.roundCounter).toBe(1);
		expect(status.frozenTaskSets).toBe(1);
		expect(status.stopped).toBe(false);
	});
});
