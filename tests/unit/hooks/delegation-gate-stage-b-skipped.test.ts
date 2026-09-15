/**
 * Issue #2756 regression tests — foreground Stage B TESTED SKIPPED verdict.
 *
 * A `[TESTED] | task-N | SKIPPED | ...` verdict means the tests were NOT run
 * (tool-argument outcome, e.g. prohibited scope / framework detection none).
 * The delegation gate must leave the task in its Stage B eligible state with
 * the reviewer's gate proof intact so the architect can re-dispatch the test
 * gate — NOT score it as stage_b_failed/rework_required (issue #2756 defect 2,
 * foreground path). Genuine FAIL verdicts keep the rejection semantics.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	readTaskEvidence,
	recordAgentDispatch,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let tempDir: string;
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

function makeConfig() {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: true,
			delegation_max_chars: 4000,
		},
	} as import('../../../src/config').PluginConfig;
}

function writePlan(directory: string, taskIds: string[]): void {
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Stage B skipped verdict test',
			swarm: 'test',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Implementation',
					status: 'in_progress',
					tasks: taskIds.map((id) => ({
						id,
						phase: 1,
						status: 'in_progress',
						size: 'small',
						description: `Implement ${id}`,
						depends: [],
						files_touched: [],
					})),
				},
			],
		}),
	);
}

/** Stage A passed + reviewer APPROVED durable proof; task state reviewer_run. */
async function seedReviewerApproved(
	directory: string,
	taskId: string,
): Promise<void> {
	writePlan(directory, [taskId]);
	await recordAgentDispatch(directory, taskId, 'coder');
	const generation = (await readTaskEvidence(directory, taskId))!.workflow!
		.generation;
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'stage_a_passed',
		expectedGeneration: generation,
	});
	await recordGateEvidence(
		directory,
		taskId,
		'reviewer',
		'seed-reviewer',
		undefined,
		{
			expectedGeneration: generation,
		},
	);
}

async function runTestEngineerDispatch(
	hook: ReturnType<typeof createDelegationGateHook>,
	sessionID: string,
	callID: string,
	taskId: string,
	verdictLine: string,
): Promise<void> {
	const args = {
		subagent_type: 'test_engineer',
		task_id: taskId,
		prompt: `TASK: ${taskId}\nTASKS: ${taskId}\nACCEPTANCE: test_engineer must report an exact structured verdict for every listed task`,
	};
	await hook.toolBefore({ tool: 'Task', sessionID, callID }, { args });
	await hook.toolAfter(
		{ tool: 'Task', sessionID, callID, args },
		{ output: verdictLine },
	);
}

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	tempDir = canonicalMkdtemp('dg-stage-b-skipped-');
	fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	resetSwarmState();
	try {
		fs.rmSync(tempDir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	} catch {
		// best-effort cleanup
	}
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

describe('Stage B TESTED SKIPPED verdict is retryable, not a failure (#2756)', () => {
	it('SKIPPED leaves the task at reviewer_run with reviewer proof intact', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		startAgentSession('sess-skip-1', 'architect');
		const session = ensureAgentSession('sess-skip-1');
		await seedReviewerApproved(tempDir, '1.1');
		session.taskWorkflowStates.set('1.1', 'reviewer_run');
		session.currentTaskId = '1.1';

		await runTestEngineerDispatch(
			hook,
			'sess-skip-1',
			'call-skip-1',
			'1.1',
			'[TESTED] | task-1.1 | SKIPPED | PROHIBITED SCOPE: test_runner refuses scope "all" — tests not run',
		);

		expect(session.taskWorkflowStates.get('1.1')).toBe('reviewer_run');
		const evidence = await readTaskEvidence(tempDir, '1.1');
		expect(evidence?.workflow?.state).toBe('reviewer_run');
		expect(evidence?.workflow?.lastOutcome).not.toBe('stage_b_failed');
		expect(evidence?.gates?.reviewer).toBeDefined();
	});

	it('SKIPPED does not consume the reviewer completion entry', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		startAgentSession('sess-skip-2', 'architect');
		const session = ensureAgentSession('sess-skip-2');
		await seedReviewerApproved(tempDir, '1.1');
		session.taskWorkflowStates.set('1.1', 'reviewer_run');
		session.currentTaskId = '1.1';
		session.stageBCompletion?.set('1.1', new Set(['reviewer']));

		await runTestEngineerDispatch(
			hook,
			'sess-skip-2',
			'call-skip-2',
			'1.1',
			'[TESTED] | task-1.1 | SKIPPED | framework detection returned none',
		);

		expect(session.taskWorkflowStates.get('1.1')).toBe('reviewer_run');
		expect(session.stageBCompletion?.get('1.1')).toBeDefined();
	});

	it('genuine FAIL verdict still moves the task to rework_required and clears reviewer proof', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		startAgentSession('sess-fail-1', 'architect');
		const session = ensureAgentSession('sess-fail-1');
		await seedReviewerApproved(tempDir, '1.1');
		session.taskWorkflowStates.set('1.1', 'reviewer_run');
		session.currentTaskId = '1.1';

		await runTestEngineerDispatch(
			hook,
			'sess-fail-1',
			'call-fail-1',
			'1.1',
			'[TESTED] | task-1.1 | FAIL | 6/10 tests passed — missing error path tests',
		);

		expect(session.taskWorkflowStates.get('1.1')).toBe('rework_required');
		const evidence = await readTaskEvidence(tempDir, '1.1');
		expect(evidence?.workflow?.state).toBe('rework_required');
		expect(evidence?.gates?.reviewer).toBeUndefined();
	});

	it('REVIEWED REJECTED still moves the task to rework_required', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		startAgentSession('sess-rej-1', 'architect');
		const session = ensureAgentSession('sess-rej-1');
		await seedReviewerApproved(tempDir, '1.1');
		session.taskWorkflowStates.set('1.1', 'reviewer_run');
		session.currentTaskId = '1.1';

		const args = {
			subagent_type: 'reviewer',
			task_id: '1.1',
			prompt:
				'TASK: 1.1\nTASKS: 1.1\nACCEPTANCE: reviewer must report an exact structured verdict for every listed task',
		};
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'sess-rej-1', callID: 'call-rej-1' },
			{ args },
		);
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'sess-rej-1', callID: 'call-rej-1', args },
			{ output: '[REVIEWED] | task-1.1 | REJECTED | critical defect found' },
		);

		expect(session.taskWorkflowStates.get('1.1')).toBe('rework_required');
	});
});
