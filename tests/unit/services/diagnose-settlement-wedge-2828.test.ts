/**
 * Issue #2828 — the "Coder Settlements" diagnose check must surface the
 * settlement_wedge class: a task whose workflow drifted to idle/blocked
 * while a COMMITTED accepted coder settlement plus green post-settlement
 * pre-check proof still justify Stage A. Pins the end-to-end diagnose
 * rendering (task line + /swarm recover remediation) for both shapes so the
 * category can never be silently dropped from operator output again.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { saveEvidence } from '../../../src/evidence/manager';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import { getDiagnoseData } from '../../../src/services/diagnose-service';
import { resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const FIXED_NOW_MS = new Date('2026-01-01T00:00:00.000Z').getTime();
const SETTLED_AT_ISO = new Date(FIXED_NOW_MS - 60_000).toISOString();

let directory = '';
let cleanup = (): void => {};

beforeEach(() => {
	resetSwarmState();
	({ dir: directory, cleanup } = createSafeTestDir('diagnose-sw-2828-'));
});

afterEach(() => {
	resetSwarmState();
	cleanup();
});

function writeCommittedWal(taskId: string): void {
	const walDir = path.join(directory, '.swarm', 'coder-settlements');
	fs.mkdirSync(walDir, { recursive: true });
	fs.writeFileSync(
		path.join(walDir, `${taskId}.json`),
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
			accepted: true,
			recordedAt: SETTLED_AT_ISO,
		}),
	);
}

async function writeGreenBundles(): Promise<void> {
	await saveEvidence(directory, 'secretscan', {
		task_id: 'secretscan',
		type: 'secretscan',
		timestamp: SETTLED_AT_ISO,
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
		timestamp: SETTLED_AT_ISO,
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

function findCheck(
	checks: Array<{ name: string; status: string; detail: string }>,
	name: string,
) {
	return checks.find((entry) => entry.name === name);
}

describe('diagnose — settlement_wedge visibility (issue #2828)', () => {
	test('surfaces the idle settlement wedge with the recover remediation', async () => {
		await settleAt('2.1', 'idle');
		writeCommittedWal('2.1');
		await writeGreenBundles();

		const data = await getDiagnoseData(directory);
		const check = findCheck(data.checks, 'Coder Settlements');

		expect(check?.status).toBe('⚠️');
		expect(check?.detail).toContain('task 2.1 [settlement_wedge]');
		expect(check?.detail).toContain('workflow at idle');
		expect(check?.detail).toContain('/swarm recover 2.1');
		expect(check?.detail).toContain('settlement_wedge');
	});

	test('surfaces the blocked settlement wedge with the recover remediation', async () => {
		await settleAt('2.2', 'blocked');
		writeCommittedWal('2.2');
		await writeGreenBundles();

		const data = await getDiagnoseData(directory);
		const check = findCheck(data.checks, 'Coder Settlements');

		expect(check?.status).toBe('⚠️');
		expect(check?.detail).toContain('task 2.2 [settlement_wedge]');
		expect(check?.detail).toContain('workflow at blocked');
		expect(check?.detail).toContain('/swarm recover 2.2');
	});

	test('a receipts-less idle task stays informational (no fabricated wedge)', async () => {
		await settleAt('2.3', 'idle');
		await writeGreenBundles();

		const data = await getDiagnoseData(directory);
		const check = findCheck(data.checks, 'Coder Settlements');

		expect(check?.status).toBe('✅');
		expect(check?.detail).not.toContain('settlement_wedge');
	});
});
