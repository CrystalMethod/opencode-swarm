import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { runHarnessOptRound } from '../../../src/services/harness-optimizer/controller.js';
import {
	listHarnessOptLineage,
	replayHarnessOptLineage,
} from '../../../src/services/harness-optimizer/lineage.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let root = '';

beforeEach(() => {
	root = canonicalMkdtemp('harnessopt-replay-');
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
	{ id: 'replay-task', instruction: 'reply with {"v":1,"caught":true}' },
];

describe('harness-opt replay equality', () => {
	test('replay reproduces the recorded decision id exactly', async () => {
		const round = await runHarnessOptRound({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'replay-equality',
			executor: async () => ({
				status: 'completed' as const,
				text: '{"v":1,"caught":true}',
			}),
		});
		const replayed = await replayHarnessOptLineage({
			projectRoot: root,
			lineageId: round.roundId,
		});
		expect(replayed.decision.decisionId).toBe(round.decision.decisionId);
	});

	test('a tampered lineage record fails replay with a typed mismatch', async () => {
		const round = await runHarnessOptRound({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'replay-tamper',
			executor: async () => ({
				status: 'completed' as const,
				text: '{"v":1,"caught":true}',
			}),
		});
		const recordPath = path.join(
			root,
			'.swarm',
			'evolution',
			'harness-opt',
			'rounds',
			round.roundId,
			'record.json',
		);
		const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<
			string,
			unknown
		>;
		record.decision = {
			status: 'accept',
			decisionId: `promotion-${'f'.repeat(64)}`,
		};
		writeFileSync(recordPath, JSON.stringify(record, null, '\t'));
		await expect(
			replayHarnessOptLineage({ projectRoot: root, lineageId: round.roundId }),
		).rejects.toThrow(/REPLAY_DECISION_MISMATCH|does not equal/);
	});

	test('replay does not advance the round counter', async () => {
		const round = await runHarnessOptRound({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'replay-counter',
			executor: async () => ({
				status: 'completed' as const,
				text: '{"v":1,"caught":true}',
			}),
		});
		await replayHarnessOptLineage({
			projectRoot: root,
			lineageId: round.roundId,
		});
		const records = listHarnessOptLineage(root);
		expect(records.length).toBe(1);
		expect(records[0]!.roundCounter).toBe(1);
	});
});
