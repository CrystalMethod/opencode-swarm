/**
 * #3169 Phase 2 — v2 session-client blast radius (AC7-AC8): the consumers
 * that flip from client-absent paths when the shim installs keep explicit
 * typed behavior, and the read-only denial map covers every tool key. Fakes
 * only; no mock.module, no clock reads.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS } from '../../../../src/epic/phase-readiness';
import { DEFAULT_READ_ONLY_TOOLS } from '../../../../src/evaluation/ephemeral-agent-dispatcher';
import { createEvaluationModelDispatcher } from '../../../../src/evaluation/model-dispatcher';
import {
	clearV2SessionClientState,
	createV2SessionClient,
	readOnlyToolsToV2Permissions,
} from '../../../../src/host/v2/session-client';
import type { V2PluginContext } from '../../../../src/host/v2/types';
import { resetSwarmState, swarmState } from '../../../../src/state';
import { _internals as dispatchLanesInternals } from '../../../../src/tools/dispatch-lanes';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

function makeFakeSessionDomain(directory: string) {
	const calls: Array<{ op: string; arg: unknown }> = [];
	return {
		calls,
		async hook() {
			return { dispose: async () => {} };
		},
		async create(input: { location?: { directory: string } }) {
			calls.push({ op: 'create', arg: input });
			return { id: 'ses_eval_1', location: input.location ?? { directory } };
		},
		async get({ sessionID }: { sessionID: string }) {
			calls.push({ op: 'get', arg: sessionID });
			return { id: sessionID, location: { directory } };
		},
		async remove(input: unknown) {
			calls.push({ op: 'remove', arg: input });
		},
		async prompt(input: unknown) {
			calls.push({ op: 'prompt', arg: input });
			return {};
		},
		async wait(input: unknown) {
			calls.push({ op: 'wait', arg: input });
		},
		async context(_input: unknown) {
			calls.push({ op: 'context', arg: _input });
			return [
				{ role: 'user', text: 'p' },
				{ role: 'assistant', text: 'summary text' },
				{ type: 'idle', outcome: 'succeeded' },
			];
		},
		async interrupt(input: unknown) {
			calls.push({ op: 'interrupt', arg: input });
		},
	};
}

function makeFakeCtx(
	directory: string,
	sessionDomain: unknown,
): V2PluginContext {
	return {
		app: { name: 'opencode', version: 'test', channel: 'test' },
		location: { directory, workspaceID: 'w' },
		options: {},
		tool: {},
		agent: {},
		command: {},
		session: sessionDomain,
		event: {},
	} as never;
}

afterEach(() => {
	resetSwarmState();
	clearV2SessionClientState();
});

describe('v2 session-client blast radius (issue #3169 Phase 2)', () => {
	test('AC7 the shim session ops expose no lane-tool surfaces, so the existing typed guards fire', async () => {
		const directory = canonicalMkdtemp('swarm-v2-br-');
		try {
			const client = createV2SessionClient(
				makeFakeCtx(directory, makeFakeSessionDomain(directory)),
			)!;
			swarmState.opencodeClient = client as never;
			const session = dispatchLanesInternals.getSessionOps() as Record<
				string,
				unknown
			>;
			expect(session).toBeTruthy();
			// dispatch-lanes.ts:1347 guards `typeof session.promptAsync !== 'function'`
			// (typed no_client refusal), :2175 `messages`, :4031/:4119 `status`;
			// cancel-lane-batch.ts:180 `status` (probe-unavailable). The shim
			// deliberately omits all three so those guards route to typed refusals.
			expect(typeof session.promptAsync).toBe('undefined');
			expect(typeof session.messages).toBe('undefined');
			expect(typeof session.status).toBe('undefined');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('AC7 evaluation dispatcher returns the typed app.agents error on the shim', async () => {
		const directory = canonicalMkdtemp('swarm-v2-br-');
		try {
			const client = createV2SessionClient(
				makeFakeCtx(directory, makeFakeSessionDomain(directory)),
			)!;
			const dispatcher = createEvaluationModelDispatcher(client as never);
			const result = await dispatcher({
				modelId: 'opencode/review-model',
				agentName: 'eval',
				prompt: 'summarize',
				sessionDirectory: directory,
				timeoutMs: 5_000,
			});
			expect(result.status).toBe('error');
			expect(String(result.error)).toContain('no app.agents surface');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('AC7 evaluation dispatcher with a full app.agents surface still dispatches (guard is a no-op on v1 clients)', async () => {
		const directory = canonicalMkdtemp('swarm-v2-br-');
		try {
			// v1-shaped client: the guard's feature-detect must not fire when
			// app.agents exists, and the dispatcher's v1 contract (create →
			// prompt → {data:{info,parts}} → delete) must complete.
			const fullClient = {
				app: {
					agents: async () => ({ data: [{ name: 'eval' }] }),
				},
				session: {
					create: async () => ({ data: { id: 'ses_v1_1' } }),
					prompt: async () => ({
						data: {
							info: {
								providerID: 'opencode',
								modelID: 'review-model',
							},
							parts: [{ type: 'text', text: 'summary text' }],
						},
					}),
					delete: async () => ({}),
				},
			};
			const dispatcher = createEvaluationModelDispatcher(fullClient as never);
			const result = await dispatcher({
				modelId: 'opencode/review-model',
				agentName: 'eval',
				prompt: 'summarize',
				sessionDirectory: directory,
				timeoutMs: 5_000,
			});
			expect(result.status).toBe('completed');
			expect(result.text).toBe('summary text');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('AC8 permission mapping covers every DEFAULT_READ_ONLY_TOOLS key with deny-only entries', () => {
		const permissions = readOnlyToolsToV2Permissions(DEFAULT_READ_ONLY_TOOLS);
		const expectedKeys = Object.keys(DEFAULT_READ_ONLY_TOOLS);
		expect(permissions).toHaveLength(expectedKeys.length);
		expect(permissions.every((p) => p.effect === 'deny')).toBe(true);
		expect(permissions.every((p) => p.action === 'tool')).toBe(true);
		expect(new Set(permissions.map((p) => p.resource))).toEqual(
			new Set(expectedKeys),
		);
	});

	test('AC8 permission mapping covers every EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS key and re-enables bash', () => {
		const permissions = readOnlyToolsToV2Permissions(
			EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS,
		);
		const expectedKeys = Object.keys(EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS);
		expect(permissions).toHaveLength(expectedKeys.length);
		expect(new Set(permissions.map((p) => p.resource))).toEqual(
			new Set(expectedKeys),
		);
		expect(permissions.some((p) => p.resource === 'bash')).toBe(false);
		expect(permissions.every((p) => p.effect === 'deny')).toBe(true);
	});
});
