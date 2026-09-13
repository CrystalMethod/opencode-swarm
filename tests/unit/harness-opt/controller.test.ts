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

describe('stop and status', () => {
	test('operator stop halts rounds until cleared', async () => {
		await stopHarnessOptLoop({ projectRoot: root, reason: 'operator halt' });
		const status = harnessOptStatus(root);
		expect(status.stopped).toBe(true);
		expect(status.stopReason).toBe('operator halt');
		let refused: unknown;
		try {
			await runHarnessOptRound({
				projectRoot: root,
				tasks,
				split: 'validation',
				seed: 'stopped-seed',
				executor: okExecutor,
			});
		} catch (error) {
			refused = error;
		}
		expect(String(refused)).toMatch(/stopped \(operator halt\)/);
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
