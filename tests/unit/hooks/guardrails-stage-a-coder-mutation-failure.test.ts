/** Regression coverage for the failure-side coder-mutation workflow guard. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const FAIL_PAYLOAD = JSON.stringify({
	gates_passed: false,
	total_duration_ms: 1,
	batch_status: 'completed',
	lint: { ran: true, duration_ms: 1 },
	secretscan: {
		ran: true,
		duration_ms: 1,
		result: {
			count: 1,
			findings: ['test-secret'],
			files_scanned: 1,
			incomplete_files: 0,
			incomplete_paths: [],
		},
	},
	sast_scan: { ran: true, duration_ms: 1, result: { verdict: 'pass' } },
	quality_budget: { ran: false, duration_ms: 0 },
});

function defaultConfig(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
	};
}

let cleanup: () => void;
let directory: string;

beforeEach(() => {
	({ dir: directory, cleanup } = createSafeTestDir(
		'guardrails-coder-mutation',
	));
	resetSwarmState();
});

afterEach(() => {
	cleanup();
	resetSwarmState();
});

describe('coder-mutation-required Stage A failure guidance', () => {
	test('does not mislabel a failed Stage A write as an attribution miss', async () => {
		ensureAgentSession('architect').currentTaskId = '9.11';
		const hooks = createGuardrailsHooks(directory, defaultConfig());

		await hooks.toolBefore(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c-fail' },
			{ args: {} },
		);
		await hooks.toolAfter(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c-fail' },
			{ title: '', output: FAIL_PAYLOAD, metadata: null },
		);

		const messages =
			swarmState.agentSessions.get('architect')?.pendingAdvisoryMessages ?? [];
		const advisory = messages.find((message) =>
			message.includes('TASK_WORKFLOW_CODER_MUTATION_REQUIRED'),
		);
		expect(advisory).toBeDefined();
		expect(advisory).toContain('accepted coder mutation');
		expect(advisory).toContain('before Stage A');
		expect(advisory).not.toContain('NOT attributed');
		expect(advisory).not.toContain('/swarm recover');
	});
});
