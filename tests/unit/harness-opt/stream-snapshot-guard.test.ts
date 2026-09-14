import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	computeArmStreamDigest,
	runComparativeProtocol,
	StreamSnapshotDuplicateError,
} from '../../../src/services/harness-optimizer/comparative.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let root = '';

beforeEach(() => {
	root = canonicalMkdtemp('harnessopt-snapshot-');
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

const tasks = [{ id: 'snap-task', instruction: 'reply with a verdict' }];

describe('stream-snapshot duplicate guard', () => {
	test('rejects an arm digest already recorded for the same population', async () => {
		const first = await runComparativeProtocol({
			projectRoot: root,
			tasks,
			seed: 'snapshot-seed',
			executor: async () => ({ status: 'completed', text: '' }),
		});
		const previous = Object.values(first.arms).map((arm) => arm.streamDigest);
		await expect(
			runComparativeProtocol({
				projectRoot: root,
				tasks,
				seed: 'snapshot-seed',
				executor: async () => ({ status: 'completed', text: '' }),
				previousStreamDigests: previous,
			}),
		).rejects.toBeInstanceOf(StreamSnapshotDuplicateError);
	});

	test('the same tasks under a different seed produce distinct digests', () => {
		const a = computeArmStreamDigest({ arm: 'baseline', seed: 'one', tasks });
		const b = computeArmStreamDigest({ arm: 'baseline', seed: 'two', tasks });
		expect(a).not.toBe(b);
	});

	test('two arms of one protocol never collide on digests', async () => {
		const result = await runComparativeProtocol({
			projectRoot: root,
			tasks,
			seed: 'distinct-seed',
			executor: async () => ({ status: 'completed', text: '' }),
		});
		const digests = new Set(
			Object.values(result.arms).map((arm) => arm.streamDigest),
		);
		expect(digests.size).toBe(3);
	});
});
