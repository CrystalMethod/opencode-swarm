import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { runHarnessOptRound } from '../../../src/services/harness-optimizer/controller.js';
import {
	listHarnessOptLineage,
	replayHarnessOptLineage,
} from '../../../src/services/harness-optimizer/lineage.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let root = '';

beforeEach(() => {
	root = canonicalMkdtemp('harnessopt-lineage-');
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
	{ id: 'lineage-task', instruction: 'reply with {"v":1,"caught":true}' },
];

describe('durable round lineage', () => {
	test('records digests, unknown-not-zero tokens, replay id, outcome, decision', async () => {
		await runHarnessOptRound({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'lineage-seed',
			executor: async () => ({
				status: 'completed' as const,
				text: '{"v":1,"caught":true}',
			}),
		});
		const records = listHarnessOptLineage(root);
		expect(records.length).toBeGreaterThan(0);
		const record = records[records.length - 1]!;
		expect(typeof record.candidateConfigDigest).toBe('string');
		expect(record.candidateConfigDigest.length).toBeGreaterThan(0);
		expect(typeof record.promptSelectionDigest).toBe('string');
		for (const field of [
			'tokens_input',
			'tokens_cache',
			'tokens_output',
		] as const) {
			const value = record[field];
			expect(
				value === 'unknown' || (typeof value === 'number' && value > 0),
				`${field} must be unknown or a positive count, never 0`,
			).toBe(true);
		}
		expect(record.replayLineageId).toBe(record.roundId);
		expect(typeof record.artifactOutcome).toBe('string');
		expect(typeof record.decision.status).toBe('string');
		expect(['accept', 'reject']).toContain(record.oracle.verdict);
		expect(Array.isArray(record.oracle.reasons)).toBe(true);
	});

	test('token passthrough records host-supplied counts', async () => {
		await runHarnessOptRound({
			projectRoot: root,
			tasks,
			split: 'validation',
			seed: 'tokens-seed',
			executor: async () => ({
				status: 'completed' as const,
				text: '{"v":1,"caught":true}',
				tokens: { input: 10, cache: 5, output: 7 },
			}),
		});
		const record = listHarnessOptLineage(root).at(-1)!;
		expect(record.tokens_input).toBe(10);
		expect(record.tokens_cache).toBe(5);
		expect(record.tokens_output).toBe(7);
	});

	test('replay returns the identical decision without re-consuming a held-out claim', async () => {
		const round = await runHarnessOptRound({
			projectRoot: root,
			tasks,
			split: 'test',
			seed: 'replay-seed',
			executor: async () => ({
				status: 'completed' as const,
				text: '{"v":1,"caught":true}',
			}),
		});
		const replayed = await replayHarnessOptLineage({
			projectRoot: root,
			lineageId: round.roundId,
		});
		expect(replayed.decision.status).toBe(round.decision.status);
		expect(replayed.decision.decisionId).toBe(round.decision.decisionId);
	});

	test('replay of an unknown lineage id fails typed', async () => {
		await expect(
			replayHarnessOptLineage({
				projectRoot: root,
				lineageId: 'round-doesnotexist',
			}),
		).rejects.toThrow(/not found/);
	});
});
