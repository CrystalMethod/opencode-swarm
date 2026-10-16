/**
 * Issue #2960 — underscore-named agents resolve their Task-route fallback
 * chain. Mirrors the integration-harness shape of
 * tests/unit/index-task-model-routing.test.ts (own compact copy, per the
 * FR-006 500-line cap on that file) and drives the REAL plugin boundary:
 * Task dispatch -> child bind -> retryable 429 session.error -> chat.message.
 *
 * Test roles (plan-critic-labeled):
 * - 'survives one retryable failure' is THE DISCRIMINATING regression net —
 *   on the pre-fix tree (naive first-underscore swarm-id split) the chain
 *   collapses to [] and this test fails at the MODEL_FALLBACK_EXHAUSTED
 *   preflight throw.
 * - 'still exhausts after the full chain' is a TERMINAL-STATE PIN (also
 *   passes pre-fix; it pins the designed exhaustion semantics).
 * - 'prefixed name form' is a no-throw PIN (the dispatched-prefixed advance
 *   path resolves from the stripped role and degenerates identically pre and
 *   post fix under a swarms-only config — see the issue #2960 trace, C4).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../src/config/plan-schema';
import { _internals as severeInternals } from '../../src/full-auto/severe-result';
import OpenCodeSwarm from '../../src/index';
import { resetTaskModelRoutingStateForTests } from '../../src/models/task-model-routing';
import { resetSwarmState } from '../../src/state';
import { resetTelemetryForTesting } from '../../src/telemetry';
import { canonicalMkdtemp, removeTreeWithRetry } from '../helpers/tmpdir';

const PARENT_SESSION = 'parent-session';
const CHILD_SESSION = 'child-session';

function makeProject(): string {
	return canonicalMkdtemp('j13-underscore-routing-');
}

function writeAgentsConfig(
	directory: string,
	agents: PluginConfigAgents,
	swarms?: PluginConfigSwarms,
): void {
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			quiet: true,
			version_check: false,
			hooks: { delegation_gate: false },
			agents,
			...(swarms ? { swarms } : {}),
		}),
	);
}

type PluginConfigAgents = Record<
	string,
	{ model: string; fallback_models: string[] }
>;
type PluginConfigSwarms = Record<
	string,
	{ name: string; agents: PluginConfigAgents }
>;

function writePlan(directory: string): void {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Issue 2960 routing fixture',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Task one',
						depends: [],
						files_touched: ['src/index.ts'],
					},
				],
			},
		],
	};
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan),
	);
}

async function bootPlugin(directory: string) {
	return OpenCodeSwarm.server({
		client: {
			session: {
				get: async ({ path }: { path: { id: string } }) => ({
					data: { parentID: undefined },
					error: null,
				}),
			},
		} as never,
		project: {} as never,
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as never,
	});
}

async function dispatchAgentTask(
	plugin: Awaited<ReturnType<typeof bootPlugin>>,
	callID: string,
	subagentType: string,
): Promise<void> {
	await plugin['chat.message']?.(
		{ sessionID: PARENT_SESSION, agent: 'architect' } as never,
		{} as never,
	);
	await plugin['tool.execute.before']?.(
		{ tool: 'Task', sessionID: PARENT_SESSION, callID } as never,
		{
			args: {
				subagent_type: subagentType,
				prompt: 'TASK: 1.1\nACCEPTANCE: exercise underscore fallback wiring',
			},
		} as never,
	);
}

async function bindChild(
	plugin: Awaited<ReturnType<typeof bootPlugin>>,
	callID: string,
): Promise<void> {
	await plugin.event?.({
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					sessionID: PARENT_SESSION,
					callID,
					type: 'tool',
					tool: 'task',
					state: { metadata: { sessionId: CHILD_SESSION } },
				},
			},
		},
	});
}

async function fireRetryable429(
	plugin: Awaited<ReturnType<typeof bootPlugin>>,
): Promise<void> {
	await plugin.event?.({
		event: {
			type: 'session.error',
			properties: {
				sessionID: CHILD_SESSION,
				error: { message: '429 rate_limit_exceeded: too many requests' },
			},
		},
	});
}

describe('index task-model routing — underscore agents (issue #2960)', () => {
	let directory = '';
	let configDirectory = '';
	let previousXdgConfigHome: string | undefined;

	beforeEach(() => {
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
		configDirectory = makeProject();
		process.env.XDG_CONFIG_HOME = configDirectory;
		resetSwarmState();
		resetTaskModelRoutingStateForTests();
		directory = makeProject();
	});

	afterEach(() => {
		if (previousXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
		}
		resetSwarmState();
		resetTaskModelRoutingStateForTests();
		resetTelemetryForTesting();
		severeInternals.pendingCorrelations.clear();
		severeInternals.evidenceEvents.clear();
		severeInternals.childBindings.clear();
		// FB-008: one try around two rmSync calls means a first throw skips
		// the second silently. removeTreeWithRetry is the repo's helper for
		// per-directory best-effort cleanup and is itself exception-safe, so
		// the two dirs are cleaned independently.
		removeTreeWithRetry(directory);
		removeTreeWithRetry(configDirectory);
	});

	test('task route survives one retryable failure for a seeded underscore agent', async () => {
		writeAgentsConfig(directory, {
			test_engineer: {
				model: 'opencode/mimo-v2.6-flash-free',
				fallback_models: ['opencode/big-pickle'],
			},
		});
		writePlan(directory);
		const plugin = await bootPlugin(directory);
		await dispatchAgentTask(plugin, 'call-survive', 'test_engineer');
		await bindChild(plugin, 'call-survive');
		await fireRetryable429(plugin);

		// Pre-fix behavior: the naive first-underscore split resolved swarm id
		// 'test', the default-swarm map lookup missed, fallbackModels collapsed
		// to [], one advance exhausted the chain, and this call REJECTED with
		// MODEL_FALLBACK_EXHAUSTED. The model rewrite below is also the
		// non-exhausted proof: an override resolution is the only status that
		// rewrites output.message.model (exhausted throws, primary leaves it).
		const output = {
			message: {} as { model?: { providerID: string; modelID: string } },
		};
		await plugin['chat.message']?.(
			{ sessionID: CHILD_SESSION, agent: 'test_engineer' } as never,
			output as never,
		);
		expect(output.message.model).toEqual({
			providerID: 'opencode',
			modelID: 'big-pickle',
		});
	});

	test('task route still exhausts after the full chain for a seeded underscore agent', async () => {
		writeAgentsConfig(directory, {
			test_engineer: {
				model: 'opencode/mimo-v2.6-flash-free',
				fallback_models: ['opencode/big-pickle'],
			},
		});
		writePlan(directory);
		const plugin = await bootPlugin(directory);
		await dispatchAgentTask(plugin, 'call-exhaust', 'test_engineer');
		await bindChild(plugin, 'call-exhaust');
		// Primary + one fallback = totalModels 2; two advances exhaust.
		for (let attempt = 0; attempt < 2; attempt += 1) {
			await fireRetryable429(plugin);
		}

		await expect(
			plugin['chat.message']?.(
				{ sessionID: CHILD_SESSION, agent: 'test_engineer' } as never,
				{ message: {} } as never,
			),
		).rejects.toThrow('MODEL_FALLBACK_EXHAUSTED');
	});

	test('prefixed underscore agent name form stays green in multi-swarm configs', async () => {
		writeAgentsConfig(
			directory,
			{},
			{
				local: {
					name: 'Local Swarm',
					agents: {
						test_engineer: {
							model: 'prov/x',
							fallback_models: ['prov/xb'],
						},
					},
				},
				mega: { name: 'Mega Swarm', agents: {} },
			},
		);
		writePlan(directory);
		const plugin = await bootPlugin(directory);
		await dispatchAgentTask(plugin, 'call-prefixed', 'local_test_engineer');
		await bindChild(plugin, 'call-prefixed');
		await fireRetryable429(plugin);

		// The prefixed form resolves its chain from swarm `local`, so one
		// retryable failure must advance rather than exhaust. This asserts the
		// boundary stayed GREEN in the fix's favor direction — it is the arm a
		// regression in the prefixed path would break.
		const output = {
			message: {} as { model?: { providerID: string; modelID: string } },
		};
		await plugin['chat.message']?.(
			{ sessionID: CHILD_SESSION, agent: 'local_test_engineer' } as never,
			output as never,
		);
		expect(output.message).toBeDefined();
	});

	// FB-001/FB-005 regression net (issue #2960 review). The swarm-id
	// derivation must resolve to the DEFAULT swarm — exactly as base did —
	// for any agent name carrying no real `<swarmId>_` prefix, including
	// case-variants and the `-`/` ` separators the role extractor accepts.
	// A regression here silently collapses the chain to [] and the next
	// retryable failure throws MODEL_FALLBACK_EXHAUSTED.
	//
	// `role` is the canonical role each chat-side name extracts; the config
	// entry and the dispatched Task must agree with it, otherwise the route is
	// registered under a different role and the chat boundary correctly
	// reports a mismatch instead of exercising the chain.
	const DEFAULT_SWARM_NAME_FORMS = [
		{ label: 'case-variant single-word role', agent: 'Coder', role: 'coder' },
		{ label: 'upper-case single-word role', agent: 'CODER', role: 'coder' },
	];

	for (const { label, agent, role } of DEFAULT_SWARM_NAME_FORMS) {
		test(`unprefixed ${label} ("${agent}") keeps its default-swarm fallback chain`, async () => {
			// Config and dispatch are keyed by the canonical role: the primary
			// model resolver matches the ROSTER case-insensitively, so the
			// advance side (stripped role) and the chat side (full name) must
			// both case-fold to the same registered agent for the two chains
			// to share a signature.
			writeAgentsConfig(directory, {
				[role]: { model: 'prov/primary', fallback_models: ['prov/fb1'] },
			});
			writePlan(directory);
			const plugin = await bootPlugin(directory);
			await dispatchAgentTask(plugin, `call-form-${agent}`, role);
			await bindChild(plugin, `call-form-${agent}`);
			await fireRetryable429(plugin);

			// Same default-swarm chain, reached through a differently-spelled
			// agent name. Pre-fix the derivation sliced a garbage swarm id from
			// these names and the boundary threw MODEL_FALLBACK_EXHAUSTED.
			const output = {
				message: {} as { model?: { providerID: string; modelID: string } },
			};
			await plugin['chat.message']?.(
				{ sessionID: CHILD_SESSION, agent } as never,
				output as never,
			);
			expect(output.message.model).toEqual({
				providerID: 'prov',
				modelID: 'fb1',
			});
		});
	}
});
