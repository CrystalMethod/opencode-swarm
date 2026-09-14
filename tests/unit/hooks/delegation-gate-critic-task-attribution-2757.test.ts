/** Regression coverage for issue #2757's plan-critic task attribution dead-end. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import { findByCorrelationId } from '../../../src/background/pending-delegations';
import type { Plan } from '../../../src/config/plan-schema';
import { closeProjectDb } from '../../../src/db/project-db';
import {
	getTaskWorkflowSnapshot,
	hasPassedAllGates,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { makeConfig } from './_delegation-gate-helpers';

const TASK_ID = '1.1';

function makePlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Critic attribution regression',
		swarm: 'mega',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'pending',
				tasks: [
					{
						id: TASK_ID,
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Implement the issue fix',
						depends: [],
						files_touched: ['src/example.ts'],
					},
				],
			},
		],
	};
}

function writePlan(directory: string): void {
	writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(makePlan(), null, 2),
		'utf8',
	);
}

async function seedStageA(sessionID: string): Promise<number> {
	const accepted = await transitionTaskWorkflowEvidence(tmpDir, TASK_ID, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: 'seed-coder',
	});
	const generation = getTaskWorkflowSnapshot(accepted).generation;
	await transitionTaskWorkflowEvidence(tmpDir, TASK_ID, {
		type: 'stage_a_passed',
		expectedGeneration: generation,
		transitionId: 'seed-stage-a',
	});
	const session = ensureAgentSession(sessionID, 'architect', tmpDir);
	session.currentTaskId = TASK_ID;
	session.taskWorkflowStates.set(TASK_ID, 'pre_check_passed');
	return generation;
}

async function settleCritic(
	hook: ReturnType<typeof createDelegationGateHook>,
	sessionID: string,
	callID: string,
	args: Record<string, unknown>,
): Promise<void> {
	await hook.toolBefore({ tool: 'Task', sessionID, callID }, { args });
	await hook.toolAfter(
		{ tool: 'Task', sessionID, callID, args },
		{ output: 'VERDICT: APPROVED\nThe review is complete.' },
	);
}

let tmpDir: string;
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

beforeEach(() => {
	// Keep user-scoped stores under a test-owned app-data root. The delegation
	// hook exercises durable evidence and route state, so this also prevents a
	// test run from touching the developer's real config/data directories.
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	tmpDir = canonicalMkdtemp('dg-critic-attribution-');
	mkdirSync(path.join(tmpDir, '.opencode'), { recursive: true });
	mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	writePlan(tmpDir);
});

afterEach(() => {
	resetSwarmState();
	closeProjectDb(tmpDir);
	safeRmRecursive(tmpDir);
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

describe('delegation-gate — regression: plan-level critic attribution (#2757)', () => {
	it('does not create task evidence from a text-only plan critic prompt', async () => {
		const sessionID = 'plan-critic-unbound';
		const session = ensureAgentSession(sessionID, 'architect', tmpDir);
		// The session may be actively working on 1.1, but plan-level critic
		// dispatches still need explicit attribution rather than this fallback.
		session.currentTaskId = TASK_ID;
		session.taskWorkflowStates.set(TASK_ID, 'pre_check_passed');
		const hook = createDelegationGateHook(makeConfig(), tmpDir);

		// Before the fix, plan-aware text extraction treated the sole `1.1` in
		// this plan-level prompt as task attribution, then recorded a per-task
		// critic requirement that could outlive the coder mutation.
		await settleCritic(hook, sessionID, 'critic-unbound', {
			subagent_type: 'critic',
			prompt:
				'MODE: CRITIC-GATE\nReview the complete plan before implementation. The plan includes 1.1.',
		});

		expect(await readTaskEvidence(tmpDir, TASK_ID)).toBeNull();
	});

	it('keeps an unbound background plan critic out of pending gate ingestion', async () => {
		const sessionID = 'background-plan-critic-unbound';
		const session = ensureAgentSession(sessionID, 'architect', tmpDir);
		// A current task must not turn free-form plan prose into a Stage-B binding.
		session.currentTaskId = TASK_ID;
		session.taskWorkflowStates.set(TASK_ID, 'pre_check_passed');
		const hook = createDelegationGateHook(
			makeConfig({
				hooks: {
					background_subagents: true,
					background_pending_timeout_minutes: 30,
				},
			}),
			tmpDir,
		);
		const args = {
			subagent_type: 'critic',
			background: true,
			prompt:
				'MODE: CRITIC-GATE\nReview the whole plan before work begins. The only task is 1.1.',
		};

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID: 'background-critic-unbound' },
			{ args },
		);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'background-critic-unbound',
				args,
			},
			{
				state: 'running',
				output:
					'<task id="background-critic-child" state="running">Background critic started</task>',
				metadata: { background: true, jobId: 'background-critic-job' },
			},
		);

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: tmpDir,
		});
		await observer.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'text',
						synthetic: true,
						sessionID,
						text:
							'<task id="background-critic-child" state="completed">\n' +
							'<task_result>VERDICT: APPROVED</task_result>\n</task>',
					},
				},
			},
		});

		const record = findByCorrelationId(tmpDir, 'background-critic-child');
		expect(record?.status).toBe('completed');
		expect(record?.planTaskId).toBeNull();
		expect(record?.evidenceTaskId).toBeNull();
		expect(record?.workflowGeneration).toBeUndefined();
		expect(await readTaskEvidence(tmpDir, TASK_ID)).toBeNull();
	});

	it('records critic evidence when the dispatch carries explicit task_id attribution', async () => {
		const sessionID = 'critic-explicit-task';
		ensureAgentSession(sessionID, 'architect', tmpDir);
		const hook = createDelegationGateHook(makeConfig(), tmpDir);

		await settleCritic(hook, sessionID, 'critic-explicit', {
			subagent_type: 'critic',
			task_id: TASK_ID,
			prompt:
				'MODE: CRITIC-GATE\nReview the implementation plan before execution.',
		});

		const evidence = await readTaskEvidence(tmpDir, TASK_ID);
		expect(evidence?.required_gates).toContain('critic');
		expect(evidence?.gates.critic).toBeDefined();
	});

	it('does not let a named ID shadow a valid TASK marker (F3)', async () => {
		const sessionID = 'critic-mixed-attribution';
		ensureAgentSession(sessionID, 'architect', tmpDir);
		const hook = createDelegationGateHook(makeConfig(), tmpDir);

		await settleCritic(hook, sessionID, 'critic-mixed-attribution', {
			subagent_type: 'critic',
			task_id: 'runtime-session-handle',
			prompt: `MODE: CRITIC-GATE\nTASK: ${TASK_ID}`,
		});

		const evidence = await readTaskEvidence(tmpDir, TASK_ID);
		expect(evidence?.required_gates).toContain('critic');
		expect(evidence?.gates.critic).toBeDefined();
	});

	it('re-satisfies explicit critic evidence after an accepted coder mutation (F14)', async () => {
		const sessionID = 'critic-explicit-rerun';
		ensureAgentSession(sessionID, 'architect', tmpDir);
		const hook = createDelegationGateHook(makeConfig(), tmpDir);

		await settleCritic(hook, sessionID, 'critic-before-mutation', {
			subagent_type: 'critic',
			task_id: TASK_ID,
			prompt: 'MODE: CRITIC-GATE\nReview the explicit task before execution.',
		});
		const beforeMutation = await readTaskEvidence(tmpDir, TASK_ID);
		expect(beforeMutation?.gates.critic).toBeDefined();

		const accepted = await transitionTaskWorkflowEvidence(tmpDir, TASK_ID, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: getTaskWorkflowSnapshot(beforeMutation).generation,
			transitionId: 'coder-after-explicit-critic',
		});
		const generation = getTaskWorkflowSnapshot(accepted).generation;
		expect(accepted.required_gates).toContain('critic');
		expect(accepted.gates.critic).toBeUndefined();

		await transitionTaskWorkflowEvidence(tmpDir, TASK_ID, {
			type: 'stage_a_passed',
			expectedGeneration: generation,
			transitionId: 'stage-a-before-explicit-critic-rerun',
		});
		await settleCritic(hook, sessionID, 'critic-after-mutation', {
			subagent_type: 'critic',
			task_id: TASK_ID,
			prompt:
				'MODE: CRITIC-GATE\nRe-review the explicit task after the coder mutation.',
		});

		const afterRerun = await readTaskEvidence(tmpDir, TASK_ID);
		expect(afterRerun?.gates.critic).toBeDefined();
	});

	it('does not leave an unsatisfiable critic requirement after a coder mutation', async () => {
		const sessionID = 'plan-critic-orphan';
		ensureAgentSession(sessionID, 'architect', tmpDir);
		const hook = createDelegationGateHook(makeConfig(), tmpDir);

		// Before the fix, this plan-level critic settlement created `critic` as a
		// task requirement. A succeeding coder mutation intentionally clears its
		// proof, but cannot satisfy the stale requirement again.
		await settleCritic(hook, sessionID, 'critic-orphan', {
			subagent_type: 'critic',
			prompt:
				'MODE: CRITIC-GATE\nReview the whole plan. Its only implementation task is 1.1.',
		});
		const accepted = await transitionTaskWorkflowEvidence(tmpDir, TASK_ID, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'coder-after-plan-critic',
		});
		const generation = getTaskWorkflowSnapshot(accepted).generation;
		await transitionTaskWorkflowEvidence(tmpDir, TASK_ID, {
			type: 'stage_a_passed',
			expectedGeneration: generation,
			transitionId: 'stage-a-after-plan-critic',
		});
		await transitionTaskWorkflowEvidence(tmpDir, TASK_ID, {
			type: 'stage_b_completed',
			gate: 'reviewer',
			sessionId: sessionID,
			routeComplete: false,
			expectedGeneration: generation,
			transitionId: 'reviewer-after-plan-critic',
		});
		await transitionTaskWorkflowEvidence(tmpDir, TASK_ID, {
			type: 'stage_b_completed',
			gate: 'test_engineer',
			sessionId: sessionID,
			routeComplete: true,
			expectedGeneration: generation,
			transitionId: 'test-engineer-after-plan-critic',
		});

		const evidence = await readTaskEvidence(tmpDir, TASK_ID);
		expect(evidence?.required_gates).not.toContain('critic');
		expect(evidence?.gates.critic).toBeUndefined();
		expect(await hasPassedAllGates(tmpDir, TASK_ID)).toBe(true);
	});

	it('preserves TASK-line routing for reviewer and test_engineer', async () => {
		const sessionID = 'stage-b-task-line';
		const generation = await seedStageA(sessionID);
		const hook = createDelegationGateHook(makeConfig(), tmpDir);

		const reviewerArgs = {
			subagent_type: 'reviewer',
			prompt: `TASK: ${TASK_ID}\nACCEPTANCE: review the exact task and report APPROVED`,
		};
		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID: 'reviewer-task-line' },
			{ args: reviewerArgs },
		);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'reviewer-task-line',
				args: reviewerArgs,
			},
			{
				output: `[REVIEWED] | task-${TASK_ID} | APPROVED | exact task approved`,
			},
		);

		const testEngineerArgs = {
			subagent_type: 'test_engineer',
			prompt: `TASK: ${TASK_ID}\nACCEPTANCE: test the exact task and report PASS`,
		};
		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID: 'test-engineer-task-line' },
			{ args: testEngineerArgs },
		);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'test-engineer-task-line',
				args: testEngineerArgs,
			},
			{ output: `[TESTED] | task-${TASK_ID} | PASS | exact task passed` },
		);

		const evidence = await readTaskEvidence(tmpDir, TASK_ID);
		expect(evidence?.gates.reviewer).toBeDefined();
		expect(evidence?.gates.test_engineer).toBeDefined();
		expect(getTaskWorkflowSnapshot(evidence)).toMatchObject({
			generation,
			state: 'tests_run',
			authoritative: true,
		});
		expect(await hasPassedAllGates(tmpDir, TASK_ID)).toBe(true);
	});

	it('preserves ambient plan-text routing for reviewer and test_engineer (F17)', async () => {
		const sessionID = 'stage-b-plan-text';
		await seedStageA(sessionID);
		const session = ensureAgentSession(sessionID, 'architect', tmpDir);
		// Force this regression through the plan-text parser rather than the
		// session fallback that is intentionally available to non-critic gates.
		session.currentTaskId = null;
		session.lastCoderDelegationTaskId = null;
		const hook = createDelegationGateHook(makeConfig(), tmpDir);
		const reviewerArgs = {
			subagent_type: 'reviewer',
			prompt:
				'Implementation plan excerpt:\n- [ ] 1.1: Review the implementation plan.\nACCEPTANCE: DONE = review complete.',
		};
		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID: 'reviewer-plan-text' },
			{ args: reviewerArgs },
		);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'reviewer-plan-text',
				args: reviewerArgs,
			},
			{
				output: `[REVIEWED] | task-${TASK_ID} | APPROVED | plan text preserved`,
			},
		);
		const testEngineerArgs = {
			subagent_type: 'test_engineer',
			prompt:
				'Implementation plan excerpt:\n- [ ] 1.1: Test the implementation plan.',
		};
		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID: 'test-engineer-plan-text' },
			{ args: testEngineerArgs },
		);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'test-engineer-plan-text',
				args: testEngineerArgs,
			},
			{ output: `[TESTED] | task-${TASK_ID} | PASS | plan text preserved` },
		);

		const evidence = await readTaskEvidence(tmpDir, TASK_ID);
		expect(evidence?.gates.reviewer).toBeDefined();
		expect(evidence?.gates.test_engineer).toBeDefined();
	});

	it('requires explicit attribution for every critic-family role (F15)', async () => {
		const roles = [
			'critic_drift_verifier',
			'critic_hallucination_verifier',
			'critic_architecture_supervisor',
		] as const;
		for (const role of roles) {
			const sessionID = `unbound-${role}`;
			ensureAgentSession(sessionID, 'architect', tmpDir);
			const hook = createDelegationGateHook(makeConfig(), tmpDir);
			await settleCritic(hook, sessionID, `call-${role}`, {
				subagent_type: role,
				prompt: `MODE: CRITIC-GATE\nReview the plan; task 1.1 is mentioned in prose.`,
			});
		}

		expect(await readTaskEvidence(tmpDir, TASK_ID)).toBeNull();
	});
});
