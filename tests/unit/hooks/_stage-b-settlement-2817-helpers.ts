/**
 * Shared fixtures for the issue #2817 Stage B settlement-drop visibility
 * tests (split across two files for the FR-006 500-line cap). Mirrors
 * tests/unit/hooks/delegation-gate-stage-b-skipped.test.ts (full-config
 * seeding) and tests/unit/hooks/issue-2491-direct-route-gate.test.ts
 * (minimal-config route fixtures).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	readTaskEvidence,
	recordAgentDispatch,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	advanceTaskState,
	ensureAgentSession,
	recordModifiedFilesForTask,
	swarmState,
} from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

export const TASK_ID = '1.1';
export const MARKER = 'STAGE B SETTLEMENT DROPPED';
export const REDISPATCH_RE = /re-?dispatch/i;
export const RESTART_RE = /restart|process-local|reload/i;
export const PLAN_TITLE = 'stage-b-settlement-drop-2817';

export function fullConfig(): PluginConfig {
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
	} as PluginConfig;
}

export function minimalConfig(council?: { enabled?: boolean }): PluginConfig {
	return {
		hooks: { delegation_gate: true },
		...(council ? { council } : {}),
	} as PluginConfig;
}

export function makeTempDir(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	// `.opencode` is REQUIRED or the project-boundary guard rejects the tempdir;
	// `.swarm` holds plan.json + durable evidence.
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

export function writePlan(
	directory: string,
	taskIds: string[] = [TASK_ID],
): void {
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: PLAN_TITLE,
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

/** Stage A passed + reviewer gate durable proof (skipped-test seeding). */
export async function seedReviewerApproved(
	directory: string,
	transitionPrefix: string,
): Promise<void> {
	writePlan(directory);
	await recordAgentDispatch(directory, TASK_ID, 'coder');
	const generation = (await readTaskEvidence(directory, TASK_ID))!.workflow!
		.generation;
	await transitionTaskWorkflowEvidence(directory, TASK_ID, {
		type: 'stage_a_passed',
		expectedGeneration: generation,
		transitionId: `${transitionPrefix}-stage-a:${TASK_ID}`,
	});
	await recordGateEvidence(
		directory,
		TASK_ID,
		'reviewer',
		'seed-reviewer',
		undefined,
		{
			expectedGeneration: generation,
		},
	);
}

/** issue-2491 fixture: durable coder mutation + Stage A + session at pre_check_passed. */
export async function seedRoutedPreCheck(
	directory: string,
	sessionID: string,
	transitionPrefix: string,
): Promise<void> {
	writePlan(directory);
	await transitionTaskWorkflowEvidence(directory, TASK_ID, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `${transitionPrefix}-coder:${TASK_ID}`,
	});
	await transitionTaskWorkflowEvidence(directory, TASK_ID, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: `${transitionPrefix}-stage-a:${TASK_ID}`,
	});
	const session = ensureAgentSession(sessionID);
	recordModifiedFilesForTask(session, TASK_ID, ['src/example.ts']);
	advanceTaskState(session, TASK_ID, 'coder_delegated');
	advanceTaskState(session, TASK_ID, 'pre_check_passed');
	session.currentTaskId = TASK_ID;
}

export async function drainRehydrations(): Promise<void> {
	await Promise.allSettled([...swarmState.pendingRehydrations]);
}

export function settlementDropAdvisories(sessionID: string): string[] {
	const session = ensureAgentSession(sessionID);
	return (session.pendingAdvisoryMessages ?? []).filter((m) =>
		m.includes(MARKER),
	);
}

export function reviewerArgs(extraPrompt: string) {
	return {
		subagent_type: 'reviewer',
		task_id: TASK_ID,
		prompt: extraPrompt,
	};
}

export function testEngineerArgs() {
	return {
		subagent_type: 'test_engineer',
		task_id: TASK_ID,
		prompt: `TASK: ${TASK_ID}\nTASKS: ${TASK_ID}\nACCEPTANCE: test_engineer must report an exact structured verdict for every listed task`,
	};
}
