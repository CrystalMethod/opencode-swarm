/**
 * settlementRecovery reducer admission + marker lifecycle (issue #2828).
 *
 * Pins the guarded entry mode itself: stage_a_passed admitted from
 * idle/blocked ONLY with the settlementRecovery flag, hard-terminal states
 * still refusing, stale generations still failing closed, and the persisted
 * marker surviving same-generation transitions while being cleared whenever
 * a new generation opens (repair_idle, accepted_mutation).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { settleAt } from './_settlement-recovery-2828-helpers';

let directory = '';
let cleanup = (): void => {};

beforeEach(() => {
	({ dir: directory, cleanup } = createSafeTestDir('settlement-reducer-'));
});

afterEach(() => {
	cleanup();
});

describe('settlementRecovery reducer admission + marker lifecycle (#2828)', () => {
	test('plain stage_a_passed still fails closed from idle without the flag', async () => {
		await settleAt(directory, '8.1', 'idle');
		await expect(
			transitionTaskWorkflowEvidence(directory, '8.1', {
				type: 'stage_a_passed',
				expectedGeneration: 2,
				transitionId: 'probe:no-flag',
			}),
		).rejects.toThrow(
			'TASK_WORKFLOW_CODER_MUTATION_REQUIRED: cannot pass Stage A from idle',
		);
	});

	test('plain stage_a_passed still fails closed from blocked without the flag', async () => {
		await settleAt(directory, '8.2', 'blocked');
		await expect(
			transitionTaskWorkflowEvidence(directory, '8.2', {
				type: 'stage_a_passed',
				expectedGeneration: 1,
				transitionId: 'probe:no-flag',
			}),
		).rejects.toThrow('TASK_WORKFLOW_TERMINAL');
	});

	test('the flag admits stage_a_passed from idle and blocked, and only there', async () => {
		await settleAt(directory, '8.3', 'idle');
		await transitionTaskWorkflowEvidence(directory, '8.3', {
			type: 'stage_a_passed',
			settlementRecovery: true,
			expectedGeneration: 2,
			transitionId: 'probe:flagged',
		});
		let workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '8.3'),
		);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.settlementRecovery).toBe(true);

		await transitionTaskWorkflowEvidence(directory, '8.3', {
			type: 'task_blocked',
			expectedGeneration: 2,
			transitionId: 'probe:reblock',
		});
		await transitionTaskWorkflowEvidence(directory, '8.3', {
			type: 'stage_a_passed',
			settlementRecovery: true,
			expectedGeneration: 2,
			transitionId: 'probe:flagged-again',
		});
		workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '8.3'),
		);
		expect(workflow.state).toBe('pre_check_passed');
	});

	test('the flag never admits stage_a_passed from complete or closed', async () => {
		await settleAt(directory, '8.4', 'idle');
		await transitionTaskWorkflowEvidence(directory, '8.4', {
			type: 'stage_a_passed',
			settlementRecovery: true,
			expectedGeneration: 2,
			transitionId: 'probe:flagged',
		});
		await transitionTaskWorkflowEvidence(directory, '8.4', {
			type: 'task_completed',
			qaExempt: true,
			expectedGeneration: 2,
			transitionId: 'probe:complete',
		});
		await expect(
			transitionTaskWorkflowEvidence(directory, '8.4', {
				type: 'stage_a_passed',
				settlementRecovery: true,
				expectedGeneration: 2,
				transitionId: 'probe:flagged-terminal',
			}),
		).rejects.toThrow('TASK_WORKFLOW_TERMINAL');
	});

	test('stale expectedGeneration fails closed even with the flag', async () => {
		await settleAt(directory, '8.5', 'idle');
		await expect(
			transitionTaskWorkflowEvidence(directory, '8.5', {
				type: 'stage_a_passed',
				settlementRecovery: true,
				expectedGeneration: 99,
				transitionId: 'probe:stale',
			}),
		).rejects.toThrow('TASK_WORKFLOW_GENERATION_MISMATCH');
	});

	test('repair_idle clears the marker when a new generation opens', async () => {
		await settleAt(directory, '8.6', 'idle');
		await transitionTaskWorkflowEvidence(directory, '8.6', {
			type: 'stage_a_passed',
			settlementRecovery: true,
			expectedGeneration: 2,
			transitionId: 'probe:flagged',
		});
		await transitionTaskWorkflowEvidence(directory, '8.6', {
			type: 'repair_idle',
			expectedGeneration: 2,
			transitionId: 'probe:reopen',
		});
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '8.6'),
		);
		expect(workflow.state).toBe('idle');
		expect(workflow.generation).toBe(3);
		expect(workflow.settlementRecovery).toBeUndefined();
	});

	test('accepted_mutation clears the marker when a new generation opens', async () => {
		await settleAt(directory, '8.7', 'idle');
		await transitionTaskWorkflowEvidence(directory, '8.7', {
			type: 'stage_a_passed',
			settlementRecovery: true,
			expectedGeneration: 2,
			transitionId: 'probe:flagged',
		});
		await transitionTaskWorkflowEvidence(directory, '8.7', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 2,
			transitionId: 'probe:new-mutation',
		});
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '8.7'),
		);
		expect(workflow.state).toBe('coder_delegated');
		expect(workflow.generation).toBe(3);
		expect(workflow.settlementRecovery).toBeUndefined();
	});

	test('the marker survives a same-generation state-preserving transition', async () => {
		await settleAt(directory, '8.8', 'idle');
		await transitionTaskWorkflowEvidence(directory, '8.8', {
			type: 'stage_a_passed',
			settlementRecovery: true,
			expectedGeneration: 2,
			transitionId: 'probe:flagged',
		});
		await transitionTaskWorkflowEvidence(directory, '8.8', {
			type: 'task_blocked',
			expectedGeneration: 2,
			transitionId: 'probe:blocked',
		});
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '8.8'),
		);
		expect(workflow.state).toBe('blocked');
		expect(workflow.settlementRecovery).toBe(true);
	});
});
