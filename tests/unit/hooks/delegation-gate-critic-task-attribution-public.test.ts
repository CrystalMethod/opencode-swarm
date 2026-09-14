/** Public-hook guardrails for issue #2757 critic task attribution. */

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

const TASK_ONE = '1.1';
const TASK_TWO = '1.2';
const LARGE_TASK = '1.1025';
const LARGE_MARKER_TASK = '1.1024';

function makeTask(id: string): Plan['phases'][number]['tasks'][number] {
	return {
		id,
		phase: 1,
		status: 'pending',
		size: 'small',
		description: `Implement ${id}`,
		depends: [],
		files_touched: [`src/task-${id.replaceAll('.', '-')}.ts`],
	};
}

function makePlan(taskIds: string[]): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Critic attribution public-hook coverage',
		swarm: 'mega',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'pending',
				tasks: taskIds.map(makeTask),
			},
		],
	};
}

function writePlan(directory: string, plan: Plan): void {
	writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf8',
	);
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
		{ state: 'completed', output: 'VERDICT: APPROVED\nReview complete.' },
	);
}

async function seedStageA(sessionID: string, taskId: string): Promise<number> {
	const accepted = await transitionTaskWorkflowEvidence(tmpDir, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `seed-coder:${taskId}`,
	});
	const generation = getTaskWorkflowSnapshot(accepted).generation;
	await transitionTaskWorkflowEvidence(tmpDir, taskId, {
		type: 'stage_a_passed',
		expectedGeneration: generation,
		transitionId: `seed-stage-a:${taskId}`,
	});
	const session = ensureAgentSession(sessionID, 'architect', tmpDir);
	session.currentTaskId = taskId;
	session.taskWorkflowStates.set(taskId, 'pre_check_passed');
	return generation;
}

let tmpDir: string;
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	tmpDir = canonicalMkdtemp('dg-critic-public-');
	mkdirSync(path.join(tmpDir, '.opencode'), { recursive: true });
	mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	resetSwarmState();
	closeProjectDb(tmpDir);
	safeRmRecursive(tmpDir);
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

describe('delegation-gate critic attribution public boundaries', () => {
	it('requires explicit sounding-board attribution and preserves generation binding', async () => {
		writePlan(tmpDir, makePlan([TASK_ONE, TASK_TWO]));
		const unboundSession = ensureAgentSession(
			'sounding-board-unbound',
			'architect',
			tmpDir,
		);
		unboundSession.currentTaskId = TASK_ONE;
		unboundSession.taskWorkflowStates.set(TASK_ONE, 'pre_check_passed');
		const hook = createDelegationGateHook(makeConfig(), tmpDir);

		await settleCritic(hook, 'sounding-board-unbound', 'unbound', {
			subagent_type: 'critic_sounding_board',
			prompt: 'Review the whole plan; its only implementation task is 1.1.',
		});
		expect(await readTaskEvidence(tmpDir, TASK_ONE)).toBeNull();

		const structuredGeneration = await seedStageA(
			'sounding-board-structured',
			TASK_ONE,
		);
		await settleCritic(hook, 'sounding-board-structured', 'structured', {
			subagent_type: 'critic_sounding_board',
			task_id: TASK_ONE,
			prompt: 'Retry the exact task and return its approved verdict.',
		});
		const structuredEvidence = await readTaskEvidence(tmpDir, TASK_ONE);
		expect(structuredEvidence?.gates.critic_sounding_board?.agent).toBe(
			'critic_sounding_board',
		);
		expect(getTaskWorkflowSnapshot(structuredEvidence)).toMatchObject({
			generation: structuredGeneration,
			authoritative: true,
		});

		const markerGeneration = await seedStageA(
			'sounding-board-prefixed',
			TASK_TWO,
		);
		await settleCritic(hook, 'sounding-board-prefixed', 'marker', {
			subagent_type: 'mega_critic_sounding_board',
			prompt: `TASK: ${TASK_TWO}`,
		});
		const markerEvidence = await readTaskEvidence(tmpDir, TASK_TWO);
		expect(markerEvidence?.gates.critic_sounding_board?.agent).toBe(
			'critic_sounding_board',
		);
		expect(getTaskWorkflowSnapshot(markerEvidence)).toMatchObject({
			generation: markerGeneration,
			authoritative: true,
		});
	});

	it('records an explicitly bound background critic through completion ingestion', async () => {
		writePlan(tmpDir, makePlan([TASK_ONE]));
		const sessionID = 'background-critic-explicit';
		const hook = createDelegationGateHook(
			makeConfig({
				hooks: { background_subagents: true },
			}),
			tmpDir,
		);
		const args = {
			subagent_type: 'mega_critic',
			task_id: TASK_ONE,
			background: true,
			prompt: 'Review this exact task and return a trusted verdict.',
		};

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID: 'background-call' },
			{ args },
		);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'background-call',
				args,
			},
			{
				state: 'running',
				output:
					'<task id="background-critic-child" state="running">started</task>',
				metadata: { background: true, jobId: 'background-critic-job' },
			},
		);

		const pending = findByCorrelationId(tmpDir, 'background-critic-child');
		expect(pending).toMatchObject({
			planTaskId: TASK_ONE,
			evidenceTaskId: TASK_ONE,
			workflowGeneration: 0,
			status: 'pending',
		});

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

		const completed = findByCorrelationId(tmpDir, 'background-critic-child');
		expect(completed?.status).toBe('consumed');
		expect(completed?.planTaskId).toBe(TASK_ONE);
		expect(completed?.evidenceTaskId).toBe(TASK_ONE);
		const evidence = await readTaskEvidence(tmpDir, TASK_ONE);
		expect(evidence?.gates.critic).toBeDefined();
		expect(await hasPassedAllGates(tmpDir, TASK_ONE)).toBe(true);
	});

	it('uses real launch and settlement boundaries for over-limit plans', async () => {
		const taskIds = Array.from(
			{ length: 1025 },
			(_, index) => `1.${index + 1}`,
		);
		writePlan(tmpDir, makePlan(taskIds));
		const hook = createDelegationGateHook(makeConfig(), tmpDir);

		await settleCritic(hook, 'large-plan-valid', 'large-valid', {
			subagent_type: 'critic',
			task_id: LARGE_TASK,
			prompt: 'Review the explicitly selected task.',
		});
		const explicitEvidence = await readTaskEvidence(tmpDir, LARGE_TASK);
		expect(explicitEvidence?.gates.critic).toBeDefined();
		expect(await hasPassedAllGates(tmpDir, LARGE_TASK)).toBe(true);

		await settleCritic(hook, 'large-plan-marker', 'large-marker', {
			subagent_type: 'critic',
			prompt: `TASK: ${LARGE_MARKER_TASK}`,
		});
		const markerEvidence = await readTaskEvidence(tmpDir, LARGE_MARKER_TASK);
		expect(markerEvidence?.gates.critic).toBeDefined();

		await settleCritic(hook, 'large-plan-foreign', 'large-foreign', {
			subagent_type: 'critic',
			task_id: '9.9',
			prompt: 'Review the explicitly selected task.',
		});
		expect(await readTaskEvidence(tmpDir, '9.9')).toBeNull();
	});
});
