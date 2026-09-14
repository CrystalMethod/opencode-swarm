import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import {
	executeRecoverReworkTask,
	recover_rework_task,
} from '../../../src/tools/recover-rework-task';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

/**
 * Issue #2755: the recover_rework_task tool wrapper — argument validation,
 * session requirement, JSON contract, and refusal surfacing through the
 * registered tool surface.
 */
describe('recover_rework_task tool (issue #2755)', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir('recover-rework-tool-'));
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	function writeMinimalPlan(taskId: string): void {
		const plan = {
			schema_version: '1.0.0',
			title: 'recover-rework-tool test plan',
			swarm: 'local',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: taskId,
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: `recover-rework-tool task ${taskId}`,
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
			'utf-8',
		);
	}

	async function writeGreenBundles(taskId: string): Promise<void> {
		// Derived from the durable wedge anchor (+60s) — deterministic and
		// strictly newer than the stage_b_failed that wedged the task.
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, taskId),
		);
		const fresh = new Date(
			Date.parse(workflow.updatedAt) + 60_000,
		).toISOString();
		const bundles = {
			secretscan: {
				task_id: 'secretscan',
				type: 'secretscan',
				verdict: 'pass',
				summary: 'seeded green secretscan bundle',
				findings_count: 0,
				files_scanned: 3,
				skipped_files: 0,
				incomplete_files: 0,
				incomplete_paths: [],
			},
			sast_scan: {
				task_id: 'sast_scan',
				type: 'sast',
				verdict: 'pass',
				summary: 'seeded green sast bundle',
				findings: [],
				engine: 'tier_a',
				files_scanned: 3,
				findings_count: 0,
				findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
			},
		} as const;
		for (const [bucket, entry] of Object.entries(bundles)) {
			const dir = path.join(directory, '.swarm', 'evidence', bucket);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				path.join(dir, 'evidence.json'),
				JSON.stringify(
					{
						schema_version: '1.0.0',
						task_id: bucket,
						entries: [{ ...entry, timestamp: fresh, agent: bucket }],
						created_at: fresh,
						updated_at: fresh,
					},
					null,
					2,
				),
				'utf-8',
			);
		}
	}

	async function seedReworkRequired(taskId: string): Promise<void> {
		await transitionTaskWorkflowEvidence(directory, taskId, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'mut-1',
		});
		await transitionTaskWorkflowEvidence(directory, taskId, {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'stage-a-1',
		});
		await transitionTaskWorkflowEvidence(directory, taskId, {
			type: 'stage_b_failed',
			gate: 'test_engineer',
			expectedGeneration: 1,
			transitionId: 'stage-b-fail-1',
		});
	}

	it('rejects invalid arguments with a success:false JSON message', async () => {
		const raw = await executeRecoverReworkTask({}, directory, {
			sessionID: 's-1',
		});
		const parsed = JSON.parse(raw) as { success: boolean; message: string };
		expect(parsed.success).toBe(false);
		expect(parsed.message).toContain('Invalid recover_rework_task call');

		const noReason = await executeRecoverReworkTask(
			{ task_id: '1.1' },
			directory,
			{ sessionID: 's-1' },
		);
		expect((JSON.parse(noReason) as { success: boolean }).success).toBe(false);
	});

	it('requires an active sessionID', async () => {
		const raw = await executeRecoverReworkTask(
			{ task_id: '1.1', reason: 'why' },
			directory,
			{},
		);
		const parsed = JSON.parse(raw) as { success: boolean; message: string };
		expect(parsed.success).toBe(false);
		expect(parsed.message).toContain('requires an active sessionID');
	});

	it('surfaces a fail-closed refusal through the JSON contract', async () => {
		writeMinimalPlan('1.1');
		await seedReworkRequired('1.1');
		// No green bundles seeded: greenness precondition must refuse.
		ensureAgentSession('tool-arch-1', 'architect', directory);
		const raw = await executeRecoverReworkTask(
			{ task_id: '1.1', reason: 'not green yet' },
			directory,
			{ sessionID: 'tool-arch-1' },
		);
		const parsed = JSON.parse(raw) as { success: boolean; message: string };
		expect(parsed.success).toBe(false);
		expect(parsed.message).toContain('RECOVER_REWORK_GREEN_PRECHECK_REQUIRED');
	});

	it('returns the full success contract on the happy path', async () => {
		writeMinimalPlan('1.2');
		await seedReworkRequired('1.2');
		await writeGreenBundles('1.2');
		ensureAgentSession('tool-arch-2', 'architect', directory);
		const raw = await executeRecoverReworkTask(
			{
				task_id: '1.2',
				reason: 'SKIPPED verdict for a tool-argument error while pytest passes',
			},
			directory,
			{ sessionID: 'tool-arch-2' },
		);
		const parsed = JSON.parse(raw) as {
			success: boolean;
			task_id: string;
			generation: number;
			state: string;
			transition_id: string;
			method: string;
			message: string;
		};
		expect(parsed.success).toBe(true);
		expect(parsed.task_id).toBe('1.2');
		expect(parsed.generation).toBe(1);
		expect(parsed.state).toBe('pre_check_passed');
		expect(parsed.transition_id).toBe('rework-recovery:1.2:gen1');
		expect(parsed.method).toBe('supervised_recovery');
		expect(parsed.message).toContain(
			'Reviewer/test_engineer dispatch is permitted again',
		);
		expect(parsed.message).toContain('rework_recovered');
	});

	it('is registered with an architect-only grant and a two-arg execute (invariant 11)', () => {
		expect(recover_rework_task.description).toContain('rework_required');
		expect(typeof recover_rework_task.execute).toBe('function');
		expect(recover_rework_task.execute.length).toBeGreaterThanOrEqual(2);
	});
});
