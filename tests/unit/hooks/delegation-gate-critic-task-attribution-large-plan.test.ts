import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals as delegationGateInternals } from '../../../src/hooks/delegation-gate';
import { TASK_ID_RESOLUTION_LIMITS } from '../../../src/hooks/task-id-resolver';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const { resolveEvidenceTaskId } = delegationGateInternals;
const LARGE_PLAN_TASK_ID = `1.${TASK_ID_RESOLUTION_LIMITS.maxKnownIds + 1}`;

function makeLargePlan(): Record<string, unknown> {
	return {
		schema_version: '1.0.0',
		title: 'Large plan critic attribution',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: Array.from(
					{ length: TASK_ID_RESOLUTION_LIMITS.maxKnownIds + 1 },
					(_, index) => ({
						id: `1.${index + 1}`,
						phase: 1,
						status: 'pending',
						size: 'small',
						description: `Task ${index + 1}`,
						depends: [],
						files_touched: [],
					}),
				),
			},
		],
	};
}

let directory: string;

beforeEach(() => {
	resetSwarmState();
	directory = canonicalMkdtemp('critic-large-plan-');
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(makeLargePlan()),
		'utf8',
	);
});

afterEach(() => {
	resetSwarmState();
	safeRmRecursive(directory);
});

describe('critic task attribution with over-limit plans', () => {
	test('preserves explicit and exact-marker IDs from the full plan', async () => {
		const session = ensureAgentSession(
			'critic-large-plan',
			'architect',
			directory,
		);
		session.currentTaskId = '1.1';
		const options = {
			policy: 'attribution' as const,
			allowSessionFallback: false,
		};

		expect(
			await resolveEvidenceTaskId(
				{ task_id: LARGE_PLAN_TASK_ID },
				session,
				directory,
				options,
			),
		).toBe(LARGE_PLAN_TASK_ID);
		expect(
			await resolveEvidenceTaskId(
				{ prompt: `TASK: ${LARGE_PLAN_TASK_ID}` },
				session,
				directory,
				options,
			),
		).toBe(LARGE_PLAN_TASK_ID);
	});

	test('rejects explicit and marked IDs absent from the full plan', async () => {
		const session = ensureAgentSession(
			'critic-large-plan-foreign',
			'architect',
			directory,
		);
		session.currentTaskId = '1.1';
		const options = {
			policy: 'attribution' as const,
			allowSessionFallback: false,
		};

		expect(
			await resolveEvidenceTaskId(
				{ task_id: '9.9' },
				session,
				directory,
				options,
			),
		).toBeNull();
		expect(
			await resolveEvidenceTaskId(
				{ prompt: 'TASK: 9.9' },
				session,
				directory,
				options,
			),
		).toBeNull();
	});
});
