import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	computeTaskPopulationHash,
	runComparativeProtocol,
	StreamSnapshotDuplicateError,
} from '../../../src/services/harness-optimizer/comparative.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let root = '';

beforeEach(() => {
	root = canonicalMkdtemp('harnessopt-comparative-');
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
	{ id: 'task-a', instruction: 'reply with {"v":1,"caught":true}' },
	{ id: 'task-b', instruction: 'reply with {"v":1,"caught":false}' },
];

describe('runComparativeProtocol', () => {
	test('runs baseline, ablation, and simple-agent arms on one population hash with denominators', async () => {
		const result = await runComparativeProtocol({
			projectRoot: root,
			tasks,
			seed: 'comparative-test',
			executor: async (inv) =>
				inv.arm === 'ablation'
					? { status: 'failed', text: '' }
					: { status: 'completed', text: '{"v":1,"caught":true}' },
		});
		const hashes = new Set<string>();
		for (const arm of ['baseline', 'ablation', 'simple-agent'] as const) {
			const entry = result.arms[arm];
			expect(entry).toBeDefined();
			expect(entry.n).toBe(tasks.length);
			expect(entry.taskPopulationHash).toBe(computeTaskPopulationHash(tasks));
			hashes.add(entry.taskPopulationHash);
		}
		expect(hashes.size).toBe(1);
	});

	test('retains a failed arm with its outcomes (negative results are evidence)', async () => {
		const result = await runComparativeProtocol({
			projectRoot: root,
			tasks,
			seed: 'comparative-failed',
			executor: async (inv) =>
				inv.arm === 'ablation'
					? { status: 'failed', text: '' }
					: { status: 'completed', text: '{"v":1,"caught":true}' },
		});
		expect(result.arms.ablation.failed).toBe(tasks.length);
		expect(result.arms.ablation.outcomes).toHaveLength(tasks.length);
		expect(
			result.arms.ablation.outcomes.every((o) => o.status === 'failed'),
		).toBe(true);
		expect(result.arms.baseline.completed).toBe(tasks.length);
	});

	test('executors run outside the project root (disposable worktrees)', async () => {
		const seenCwds: string[] = [];
		await runComparativeProtocol({
			projectRoot: root,
			tasks: [tasks[0]!],
			seed: 'comparative-cwd',
			executor: (inv) => {
				seenCwds.push(inv.cwd);
				return { status: 'completed', text: '{"v":1,"caught":true}' };
			},
		});
		expect(seenCwds.length).toBe(3);
		for (const cwd of seenCwds) {
			expect(path.resolve(cwd)).not.toBe(path.resolve(root));
		}
	});

	test('rejects a duplicated stream snapshot digest (cumulative-claim guard)', async () => {
		const first = await runComparativeProtocol({
			projectRoot: root,
			tasks,
			seed: 'comparative-dup',
			executor: async () => ({ status: 'completed', text: '' }),
		});
		const digests = Object.values(first.arms).map((arm) => arm.streamDigest);
		await expect(
			runComparativeProtocol({
				projectRoot: root,
				tasks,
				seed: 'comparative-dup',
				executor: async () => ({ status: 'completed', text: '' }),
				previousStreamDigests: digests,
			}),
		).rejects.toBeInstanceOf(StreamSnapshotDuplicateError);
	});

	test('a mutated task population changes the population hash', () => {
		const mutated = [
			{ id: 'task-a', instruction: 'MUTATED INSTRUCTION' },
			...tasks.slice(1),
		];
		expect(computeTaskPopulationHash(mutated)).not.toBe(
			computeTaskPopulationHash(tasks),
		);
	});
});
