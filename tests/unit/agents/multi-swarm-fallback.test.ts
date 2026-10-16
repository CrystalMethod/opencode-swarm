import { describe, expect, it } from 'bun:test';
import {
	createAgents,
	extractSwarmIdFromAgentName,
	getAgentConfigs,
	getSwarmAgents,
} from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';
import { stripKnownSwarmPrefix } from '../../../src/config/schema';

describe('multi-swarm fallback model resolution', () => {
	describe('extractSwarmIdFromAgentName', () => {
		it('extracts swarm ID from prefixed agent name', () => {
			expect(extractSwarmIdFromAgentName('local_coder')).toBe('local');
			expect(extractSwarmIdFromAgentName('fast_architect')).toBe('fast');
			expect(extractSwarmIdFromAgentName('precise_reviewer')).toBe('precise');
		});

		it('returns undefined for unprefixed agent name', () => {
			expect(extractSwarmIdFromAgentName('coder')).toBeUndefined();
			expect(extractSwarmIdFromAgentName('architect')).toBeUndefined();
		});

		it('handles edge cases', () => {
			expect(extractSwarmIdFromAgentName('')).toBeUndefined();
			expect(extractSwarmIdFromAgentName('_coder')).toBeUndefined();
			expect(extractSwarmIdFromAgentName('a_b_c')).toBe('a');
		});
	});

	describe('getSwarmAgents with multi-swarm config', () => {
		it('stores and retrieves config for each swarm separately', () => {
			const config: PluginConfig = {
				swarms: {
					fast: {
						name: 'Fast',
						agents: {
							coder: {
								model: 'fast/model',
								fallback_models: ['fast/fallback1', 'fast/fallback2'],
							},
						},
					},
					precise: {
						name: 'Precise',
						agents: {
							coder: {
								model: 'precise/model',
								fallback_models: ['precise/fallback1', 'precise/fallback2'],
							},
						},
					},
				},
			};

			// Create agents to populate the swarmAgentsMap
			createAgents(config);

			// Verify each swarm's config is stored correctly
			const fastAgents = getSwarmAgents('fast');
			expect(fastAgents).toBeDefined();
			expect(fastAgents?.coder?.model).toBe('fast/model');
			expect(fastAgents?.coder?.fallback_models).toEqual([
				'fast/fallback1',
				'fast/fallback2',
			]);

			const preciseAgents = getSwarmAgents('precise');
			expect(preciseAgents).toBeDefined();
			expect(preciseAgents?.coder?.model).toBe('precise/model');
			expect(preciseAgents?.coder?.fallback_models).toEqual([
				'precise/fallback1',
				'precise/fallback2',
			]);

			// Verify default swarm (should be empty for this config)
			const defaultAgents = getSwarmAgents('default');
			expect(defaultAgents).toBeDefined();
			expect(defaultAgents).toEqual({});

			// Verify getSwarmAgents with no argument defaults to 'default'
			const defaultAgents2 = getSwarmAgents();
			expect(defaultAgents2).toBeDefined();
			expect(defaultAgents2).toEqual(defaultAgents);

			// Negative assertion: swarms must not share the same config object
			expect(fastAgents).not.toBe(preciseAgents);
		});

		it('handles legacy single-swarm mode (top-level agents config)', () => {
			const config: PluginConfig = {
				agents: {
					coder: {
						model: 'legacy/model',
						fallback_models: ['legacy/fallback'],
					},
				},
			};

			// Create agents without swarms config (legacy mode)
			createAgents(config);

			// Verify default swarm has the config
			const defaultAgents = getSwarmAgents('default');
			expect(defaultAgents).toBeDefined();
			expect(defaultAgents?.coder?.model).toBe('legacy/model');
			expect(defaultAgents?.coder?.fallback_models).toEqual([
				'legacy/fallback',
			]);

			// Verify getSwarmAgents with no argument works
			const defaultAgents2 = getSwarmAgents();
			expect(defaultAgents2).toEqual(defaultAgents);
		});

		it('handles multi-swarm with explicit default swarm and top-level merge', () => {
			const config: PluginConfig = {
				agents: {
					coder: {
						model: 'toplevel/model',
					},
				},
				swarms: {
					default: {
						name: 'Default',
						agents: {
							coder: {
								model: 'default/model',
								fallback_models: ['default/fallback'],
							},
						},
					},
					local: {
						name: 'Local',
						agents: {
							coder: {
								model: 'local/model',
								fallback_models: ['local/fallback'],
							},
						},
					},
				},
			};

			createAgents(config);

			// Verify default swarm uses swarm-specific model (swarm model wins over top-level)
			const defaultAgents = getSwarmAgents('default');
			expect(defaultAgents?.coder?.model).toBe('default/model');
			expect(defaultAgents?.coder?.fallback_models).toEqual([
				'default/fallback',
			]);

			// Verify local swarm
			const localAgents = getSwarmAgents('local');
			expect(localAgents?.coder?.model).toBe('local/model');
			expect(localAgents?.coder?.fallback_models).toEqual(['local/fallback']);
		});

		it('returns undefined for non-existent swarms', () => {
			const config: PluginConfig = {
				swarms: {
					fast: {
						name: 'Fast',
						agents: {
							coder: { model: 'fast/model' },
						},
					},
				},
			};

			createAgents(config);

			// Verify non-existent swarm returns undefined
			expect(getSwarmAgents('nonexistent')).toBeUndefined();
		});
	});

	// Issue #2960: the following tests are LOOKUP-SEMANTICS PINS — the Task
	// route resolver (resolveTaskRouteModelChain in src/index.ts) is an
	// unexported closure, so these pin the lookup facts its length-delta
	// derivation relies on. They pass on the pre-fix tree; the discriminating
	// regression net for the derivation itself is the boundary-level test in
	// tests/unit/index-task-model-routing-underscore-agents.test.ts plus the
	// frozen trace checks C1-C3.
	describe('underscore-named agent resolution (issue #2960)', () => {
		it('resolves default-swarm fallback_models for underscore-named agents', () => {
			const config: PluginConfig = {
				agents: {
					test_engineer: {
						model: 'prov/primary',
						fallback_models: ['prov/fallback'],
					},
				},
			};

			createAgents(config);

			// The length-delta derivation yields swarm id undefined for an
			// exact roster name; getSwarmAgents(undefined) resolves 'default'.
			expect(stripKnownSwarmPrefix('test_engineer')).toBe('test_engineer');
			expect(getSwarmAgents(undefined)?.test_engineer?.fallback_models).toEqual(
				['prov/fallback'],
			);
		});

		it('resolves prefixed underscore agents in multi-swarm configs', () => {
			const config: PluginConfig = {
				swarms: {
					local: {
						name: 'Local',
						agents: {
							test_engineer: {
								model: 'prov/x',
								fallback_models: ['prov/xb'],
							},
						},
					},
					mega: {
						name: 'Mega',
						agents: {},
					},
				},
			};

			createAgents(config);

			// Derivation facts for 'local_test_engineer' (the length-delta
			// pattern src/index.ts uses — NOT extractSwarmIdFromAgentName,
			// whose naive first-underscore split yields 'local' only by luck
			// of the single-prefix form).
			const role = stripKnownSwarmPrefix('local_test_engineer');
			expect(role).toBe('test_engineer');
			const swarmId =
				role !== 'local_test_engineer'
					? 'local_test_engineer'.slice(
							0,
							'local_test_engineer'.length - role.length - 1,
						)
					: undefined;
			expect(swarmId).toBe('local');
			expect(getSwarmAgents(swarmId)?.test_engineer?.fallback_models).toEqual([
				'prov/xb',
			]);
		});

		it('treats an unprefixed underscore name as the default swarm even when its first token collides with a swarm id', () => {
			const config: PluginConfig = {
				swarms: {
					test: {
						name: 'Test',
						agents: {
							test_engineer: {
								model: 'prov/x',
								fallback_models: ['prov/xb'],
							},
						},
					},
				},
			};

			createAgents(config);

			// Designed semantics (issue #2960): an unprefixed canonical name
			// resolves via the 'default' swarm. The pre-fix naive first-
			// underscore split accidentally hit swarm 'test' here; the
			// length-delta derivation deliberately does not. The 'test'
			// swarm's entry stays reachable via its prefixed name form.
			expect(getSwarmAgents(undefined)?.test_engineer).toBeUndefined();
			expect(getSwarmAgents('test')?.test_engineer?.fallback_models).toEqual([
				'prov/xb',
			]);
		});

		it('keeps underscore agent names primary in both name forms (AGENTS.md invariant 11)', () => {
			const multiSwarm: PluginConfig = {
				swarms: {
					local: {
						name: 'Local Swarm',
						agents: {
							test_engineer: {
								model: 'prov/x',
								fallback_models: ['prov/xb'],
							},
						},
					},
					mega: {
						name: 'Mega Swarm',
						agents: {},
					},
				},
			};
			const multiSwarmConfigs = getAgentConfigs(multiSwarm);
			const prefixedPrimaries = Object.entries(multiSwarmConfigs).filter(
				([name, cfg]) => name.startsWith('local_') && cfg.mode === 'primary',
			);
			// At least one prefixed agent must be primary in a multi-swarm
			// config (the v7.3.x regression class: strict default_agent
			// equality demoting every *_architect to subagent).
			expect(prefixedPrimaries.length).toBeGreaterThan(0);
			expect(multiSwarmConfigs.local_architect?.mode).toBe('primary');
			expect(multiSwarmConfigs.local_test_engineer?.mode).toBe('subagent');

			const legacy: PluginConfig = {
				default_agent: 'test_engineer',
				agents: {
					test_engineer: {
						model: 'prov/primary',
						fallback_models: ['prov/fallback'],
					},
				},
			};
			const legacyConfigs = getAgentConfigs(legacy);
			// Legacy unprefixed form: an exact default_agent match stays primary.
			expect(legacyConfigs.test_engineer?.mode).toBe('primary');
		});
	});
});
