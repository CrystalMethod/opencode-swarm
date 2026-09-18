/**
 * Settlement-wedge leg of repairWedgedStageA (issue #2828).
 *
 * The deterministic /swarm recover repair additionally recognizes tasks whose
 * workflow drifted to idle (force-repair cleared the gate proofs) or blocked
 * while a COMMITTED accepted settlement plus green post-settlement pre-check
 * bundles still justify Stage A. Split from stage-a-repair.test.ts (FR-006);
 * the live_wedge (coder_delegated) leg stays pinned there.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { saveEvidence } from '../../../src/evidence/manager';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	repairWedgedStageA,
	scanWedgedStageA,
} from '../../../src/workflow/stage-a-repair';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const FIXED_NOW_MS = new Date('2026-01-01T00:00:00.000Z').getTime();
const SETTLED_AT_ISO = new Date(FIXED_NOW_MS - 60_000).toISOString();
const STALE_AT_ISO = new Date(FIXED_NOW_MS - 120_000).toISOString();

let directory = '';
let cleanup = (): void => {};

beforeEach(() => {
	({ dir: directory, cleanup } = createSafeTestDir('settlement-wedge-'));
});

afterEach(() => {
	cleanup();
});

function writeCommittedWal(taskId: string, accepted = true): void {
	const walPath = path.join(
		directory,
		'.swarm',
		'coder-settlements',
		`${taskId}.json`,
	);
	fs.mkdirSync(path.dirname(walPath), { recursive: true });
	fs.writeFileSync(
		walPath,
		JSON.stringify({
			version: 1,
			state: 'COMMITTED',
			taskId,
			transitionId: `coder:test-${taskId}`,
			actor: 'test',
			processId: process.pid,
			runtimeId: '00000000-0000-4000-8000-000000000000',
			expectedGeneration: 1,
			context: {
				baseline: {
					directory,
					gitHead: null,
					dirtyHash: null,
					prHeadSha: null,
					scope: null,
					changedFiles: [],
				},
				declaredFiles: ['src/changed.ts'],
			},
			accepted,
			recordedAt: SETTLED_AT_ISO,
		}),
	);
}

async function writeGreenBundles(stale = false): Promise<void> {
	const stamp = stale ? STALE_AT_ISO : SETTLED_AT_ISO;
	await saveEvidence(directory, 'secretscan', {
		task_id: 'secretscan',
		type: 'secretscan',
		timestamp: stamp,
		agent: 'pre_check_batch',
		verdict: 'pass',
		summary: 'no secrets found',
		findings_count: 0,
		files_scanned: 10,
		skipped_files: 0,
		incomplete_files: 0,
		incomplete_paths: [],
	});
	await saveEvidence(directory, 'sast_scan', {
		task_id: 'sast_scan',
		type: 'sast',
		timestamp: stamp,
		agent: 'pre_check_batch',
		verdict: 'pass',
		summary: 'no findings',
		findings: [],
		engine: 'tier_a',
		files_scanned: 5,
		findings_count: 0,
		findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
	});
}

async function settleAt(
	taskId: string,
	target: 'blocked' | 'idle',
): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `coder:setup-${taskId}`,
	});
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: `pre-check:setup-${taskId}`,
	});
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'task_blocked',
		expectedGeneration: 1,
		transitionId: `terminal:setup-${taskId}`,
	});
	if (target === 'idle') {
		await transitionTaskWorkflowEvidence(directory, taskId, {
			type: 'repair_idle',
			expectedGeneration: 1,
			transitionId: `repair:setup-${taskId}`,
		});
	}
}

function repairEvents(): Record<string, unknown>[] {
	const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
	if (!fs.existsSync(eventsPath)) return [];
	return fs
		.readFileSync(eventsPath, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((event) => event.type === 'stage_a_repair');
}

describe('repairWedgedStageA settlement wedge (issue #2828)', () => {
	test('repairs the idle post-force wedge without re-running the coder', async () => {
		await settleAt('5.1', 'idle');
		writeCommittedWal('5.1');
		await writeGreenBundles();

		const { results } = await repairWedgedStageA(directory, {
			taskIds: ['5.1'],
		});

		expect(results).toEqual([
			{
				taskId: '5.1',
				outcome: 'repaired',
				generation: 2,
				transitionId: 'stage-a-repair:5.1:2',
			},
		]);
		const evidence = await readTaskEvidence(directory, '5.1');
		const workflow = getTaskWorkflowSnapshot(evidence);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.generation).toBe(2);
		expect(workflow.settlementRecovery).toBe(true);
		expect(evidence?.gates?.pre_check).toBeDefined();
	});

	test('repairs the blocked wedge and restores the Stage B precondition', async () => {
		await settleAt('5.2', 'blocked');
		writeCommittedWal('5.2');
		await writeGreenBundles();

		const { results } = await repairWedgedStageA(directory, {
			taskIds: ['5.2'],
		});

		expect(results[0]).toMatchObject({
			taskId: '5.2',
			outcome: 'repaired',
			generation: 1,
		});
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '5.2'),
		);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.generation).toBe(1);
		expect(workflow.settlementRecovery).toBe(true);
	});

	test('emits an audited settlement recovery event with predecessor linkage', async () => {
		await settleAt('5.3', 'idle');
		writeCommittedWal('5.3');
		await writeGreenBundles();

		await repairWedgedStageA(directory, { taskIds: ['5.3'] });

		const events = repairEvents();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			action: 'repaired',
			taskId: '5.3',
			settlementRecovery: true,
			via: 'swarm-recover',
			predecessorTransitionId: 'repair:setup-5.3',
		});
	});

	test('second run is idempotent (skipped_not_wedged at pre_check_passed)', async () => {
		await settleAt('5.4', 'idle');
		writeCommittedWal('5.4');
		await writeGreenBundles();
		await repairWedgedStageA(directory, { taskIds: ['5.4'] });

		const second = await repairWedgedStageA(directory, { taskIds: ['5.4'] });

		expect(second.results).toEqual([
			{
				taskId: '5.4',
				outcome: 'skipped_not_wedged',
				state: 'pre_check_passed',
			},
		]);
		expect(repairEvents()).toHaveLength(1);
	});

	test('idle without a settlement WAL is still refused (nothing justifies repair)', async () => {
		await settleAt('5.5', 'idle');
		await writeGreenBundles();

		const { results } = await repairWedgedStageA(directory, {
			taskIds: ['5.5'],
		});

		expect(results).toEqual([
			{ taskId: '5.5', outcome: 'skipped_not_wedged', state: 'idle' },
		]);
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '5.5'),
		);
		expect(workflow.state).toBe('idle');
		expect(repairEvents()).toHaveLength(0);
	});

	test('idle with only a not-accepted settlement WAL is still refused', async () => {
		await settleAt('5.6', 'idle');
		writeCommittedWal('5.6', false);
		await writeGreenBundles();

		const { results } = await repairWedgedStageA(directory, {
			taskIds: ['5.6'],
		});

		expect(results).toEqual([
			{ taskId: '5.6', outcome: 'skipped_not_wedged', state: 'idle' },
		]);
	});

	test('wedge state with stale bundles reports skipped_not_green', async () => {
		await settleAt('5.7', 'idle');
		writeCommittedWal('5.7');
		await writeGreenBundles(true);

		const { results } = await repairWedgedStageA(directory, {
			taskIds: ['5.7'],
		});

		expect(results).toEqual([
			{
				taskId: '5.7',
				outcome: 'skipped_not_green',
				reason: 'pre_check_failed_or_stale',
			},
		]);
	});

	test('the live_wedge leg stays marker-free so the modes stay distinguishable', async () => {
		await transitionTaskWorkflowEvidence(directory, '5.8', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'coder:setup-5.8',
		});
		writeCommittedWal('5.8');
		await writeGreenBundles();

		const { results } = await repairWedgedStageA(directory, {
			taskIds: ['5.8'],
		});

		expect(results[0]).toMatchObject({ taskId: '5.8', outcome: 'repaired' });
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '5.8'),
		);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.settlementRecovery).toBeUndefined();
		const events = repairEvents();
		expect(events[0]).not.toHaveProperty('settlementRecovery');
	});
});

describe('scanWedgedStageA classification (issue #2828)', () => {
	test('classifies both wedge shapes as settlement_wedge with repair allowed', async () => {
		await settleAt('6.1', 'idle');
		writeCommittedWal('6.1');
		await writeGreenBundles();
		await settleAt('6.2', 'blocked');
		writeCommittedWal('6.2');

		const scan = await scanWedgedStageA(directory, { taskIds: ['6.1', '6.2'] });

		const byTask = new Map(scan.results.map((row) => [row.taskId, row]));
		expect(byTask.get('6.1')).toMatchObject({
			category: 'settlement_wedge',
			repairAllowed: true,
		});
		expect(byTask.get('6.1')?.explanation).toContain(
			'workflow at idle while a COMMITTED accepted coder settlement',
		);
		expect(byTask.get('6.2')).toMatchObject({
			category: 'settlement_wedge',
			repairAllowed: true,
		});
	});

	test('classifies a receipts-less idle task healthy, not settlement_wedge', async () => {
		await settleAt('6.3', 'idle');
		await writeGreenBundles();

		const scan = await scanWedgedStageA(directory, { taskIds: ['6.3'] });

		expect(scan.results[0]).toMatchObject({
			category: 'healthy',
			repairAllowed: false,
		});
	});
});
