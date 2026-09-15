/**
 * Swarm-agent dispatch model preflight — issue #2680.
 *
 * Gate-level coverage (the service is covered in
 * tests/unit/services/model-preflight-2680.test.ts):
 * - The delegation gate denies a NON-critic registered agent dispatch whose
 *   final effective model does not resolve, with the distinct
 *   SWARM_AGENT_MODEL_UNRESOLVED class (critics keep PLAN_CRITIC_MODEL_UNRESOLVED).
 * - An enabled registered role with no final selection denies with
 *   SWARM_AGENT_MODEL_MISSING_SELECTION.
 * - Catalog unavailable → fail-open: the dispatch proceeds (a catalog warning
 *   alone is never dispatch-failure evidence).
 * - Primary agents are exempt (short-circuit BEFORE any catalog lookup) so a
 *   host whose catalog lacks the registered fallback model never sees a false
 *   denial while the UI-selected model is fine.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { getAgentConfigs } from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { invalidateProviderCatalogCache } from '../../../src/services/model-preflight';
import { resetSwarmState, swarmState } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function catalogClient(
	providers: { id: string; models: string[] }[],
	fail = false,
): OpencodeClient {
	return {
		provider: {
			list: async () => {
				if (fail) throw new Error('catalog unreachable');
				return {
					data: {
						all: providers.map((provider) => ({
							id: provider.id,
							name: provider.id,
							models: Object.fromEntries(
								provider.models.map((model) => [model, { id: model }]),
							),
						})),
					},
				};
			},
		},
	} as unknown as OpencodeClient;
}

const OPENCODE_CATALOG = catalogClient([
	{ id: 'opencode', models: ['big-pickle', 'minimax-m2.5-free', 'gpt-5-nano'] },
]);

const baseConfig = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true },
	worktree: { policy: 'disabled' },
} as unknown as PluginConfig;

const multiSwarmConfig = {
	...baseConfig,
	swarms: {
		local: {
			name: 'Local',
			agents: {
				coder: { model: 'ghost/broken-model' },
				explorer: { model: 'opencode/big-pickle' },
			},
		},
	},
} as unknown as PluginConfig;

describe('issue #2680 — registered-agent dispatch model preflight', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		invalidateProviderCatalogCache();
		tempDir = canonicalMkdtemp('agent-preflight-2680-');
	});

	afterEach(() => {
		resetSwarmState();
		invalidateProviderCatalogCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('[AC2] non-critic registered agent with an unresolvable final model is denied with its distinct typed class', async () => {
		swarmState.opencodeClient = OPENCODE_CATALOG;
		const registeredAgents = getAgentConfigs(multiSwarmConfig, tempDir);
		const hook = createDelegationGateHook(
			multiSwarmConfig,
			tempDir,
			registeredAgents,
		);
		const outcome = hook.toolBefore(
			{ tool: 'Task', sessionID: 'architect-1', callID: 'coder-call-1' },
			{ args: { subagent_type: 'local_coder', prompt: 'map the repo' } },
		);
		await expect(outcome).rejects.toThrow('SWARM_AGENT_MODEL_UNRESOLVED');
		await expect(outcome).rejects.toThrow('local_coder');
		await expect(outcome).rejects.toThrow('ghost/broken-model');
		await expect(outcome).rejects.toThrow('swarm override wins');
	});

	test('[AC2] critic dispatches keep the PLAN_CRITIC_MODEL_UNRESOLVED identity', async () => {
		const criticConfig = {
			...multiSwarmConfig,
			swarms: {
				local: {
					name: 'Local',
					agents: { critic: { model: 'ghost/broken-critic' } },
				},
			},
		} as unknown as PluginConfig;
		swarmState.opencodeClient = OPENCODE_CATALOG;
		const registeredAgents = getAgentConfigs(criticConfig, tempDir);
		const hook = createDelegationGateHook(
			criticConfig,
			tempDir,
			registeredAgents,
		);
		const outcome = hook.toolBefore(
			{ tool: 'Task', sessionID: 'architect-1', callID: 'critic-call-1' },
			{ args: { subagent_type: 'local_critic', prompt: 'review the plan' } },
		);
		await expect(outcome).rejects.toThrow('PLAN_CRITIC_MODEL_UNRESOLVED');
		await expect(outcome).rejects.toThrow('ghost/broken-critic');
		// The critic message must NOT carry the non-critic class name.
		const error = (await outcome.catch(
			(caught: unknown) => caught,
		)) as unknown as Error;
		expect(error.message.startsWith('PLAN_CRITIC_MODEL_UNRESOLVED')).toBe(true);
	});

	test('[AC2] a valid prefixed role dispatch proceeds on a healthy catalog', async () => {
		swarmState.opencodeClient = OPENCODE_CATALOG;
		const registeredAgents = getAgentConfigs(multiSwarmConfig, tempDir);
		const hook = createDelegationGateHook(
			multiSwarmConfig,
			tempDir,
			registeredAgents,
		);
		await expect(
			hook.toolBefore(
				{
					tool: 'Task',
					sessionID: 'architect-1',
					callID: 'explorer-call-1',
				},
				{
					args: { subagent_type: 'local_explorer', prompt: 'map the repo' },
				},
			),
		).resolves.toBeUndefined();
	});

	test('[AC5] non-critic dispatch fails open when the catalog is unreachable', async () => {
		// A read-only role whose model sits on the ghost provider: with the
		// catalog DOWN the preflight resolves 'unknown' and the dispatch
		// proceeds — an unreachable catalog is a warning surface, never
		// dispatch-failure evidence. ([AC2]'s healthy-catalog denial on the
		// same ghost provider is the symmetric control.)
		const ghostExplorerConfig = {
			...baseConfig,
			swarms: {
				local: {
					name: 'Local',
					agents: { explorer: { model: 'ghost/broken-model' } },
				},
			},
		} as unknown as PluginConfig;
		swarmState.opencodeClient = catalogClient([], true);
		const registeredAgents = getAgentConfigs(ghostExplorerConfig, tempDir);
		const hook = createDelegationGateHook(
			ghostExplorerConfig,
			tempDir,
			registeredAgents,
		);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'architect-1', callID: 'explorer-call-2' },
				{ args: { subagent_type: 'local_explorer', prompt: 'map the repo' } },
			),
		).resolves.toBeUndefined();
	});

	test('[AC6] a registered role with no final selection denies with the missing-selection class', async () => {
		swarmState.opencodeClient = OPENCODE_CATALOG;
		// Hand-built registry entry whose swarm is absent from the config: the
		// exact-name precedence chain yields nothing (stale swarm registry).
		const staleRegistry = {
			ghostswarm_coder: { model: '', mode: 'subagent' },
		} as unknown as ReturnType<typeof getAgentConfigs>;
		const configWithLocalSwarm = {
			...baseConfig,
			swarms: { local: {} },
		} as unknown as PluginConfig;
		const hook = createDelegationGateHook(
			configWithLocalSwarm,
			tempDir,
			staleRegistry,
		);
		const outcome = hook.toolBefore(
			{ tool: 'Task', sessionID: 'architect-1', callID: 'stale-call-1' },
			{ args: { subagent_type: 'ghostswarm_coder', prompt: 'map the repo' } },
		);
		await expect(outcome).rejects.toThrow(
			'SWARM_AGENT_MODEL_MISSING_SELECTION',
		);
		await expect(outcome).rejects.toThrow('ghostswarm_coder');
	});

	test('primary agents are exempt: a catalog lacking their registered model never denies a Task dispatch', async () => {
		// Catalog WITHOUT any opencode provider — the primary's registered
		// fallback model (DEFAULT_MODELS.default) is unresolvable here, but the
		// UI owns the primary's selection, so the dispatch must proceed.
		swarmState.opencodeClient = catalogClient([
			{ id: 'custom', models: ['unrelated-model'] },
		]);
		const config = {
			...baseConfig,
			swarms: { local: {} },
		} as unknown as PluginConfig;
		const registeredAgents = getAgentConfigs(config, tempDir);
		const hook = createDelegationGateHook(config, tempDir, registeredAgents);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'architect-1', callID: 'primary-call-1' },
				{ args: { subagent_type: 'local_architect', prompt: 'lead' } },
			),
		).resolves.toBeUndefined();
	});
});
