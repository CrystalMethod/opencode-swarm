/**
 * Native /swarm command dispatch on the v2 execute path (#3169 Phase 4).
 *
 * The v2 CommandDefinition.execute must route through the shared v1 command
 * handler (command.execute.before on the hooks object — registry resolution,
 * policy refusals, real handler execution, canonical output envelope) and
 * submit the handler-produced prompt via ctx.session.prompt. The raw expanded
 * template survives only as the explicit fallback (absent hook / empty parts /
 * swallowed throw), and a host without the session prompt surface must not run
 * the registry handler at all (side-effect-free no-op).
 *
 * Fakes only (no mock.module); the gate-shaped cases run the REAL
 * createSwarmCommandHandler + real registry in a bare canonicalMkdtemp project
 * with XDG_CONFIG_HOME isolated so the epic config-gate refusal
 * (epic-disabled-by-config) is the deterministic handler outcome.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createSwarmCommandHandler } from '../../../../src/commands/index';
import { registerV2AgentsAndCommands } from '../../../../src/host/v2/agents-commands';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

interface RecordedPrompt {
	sessionID: string;
	text: string;
}

interface RegisteredCommand {
	name: string;
	execute: (inv: {
		sessionID: string;
		prompt: { text: string };
	}) => Promise<void>;
}

/**
 * Register a two-command table (the `swarm-epic` shortcut and the main
 * `swarm` command) through the real registerV2AgentsAndCommands against a
 * fake v2 ctx that records every ctx.session.prompt submission.
 */
async function registerCommands(
	hooks: V1HooksSubset,
): Promise<{ commands: RegisteredCommand[]; prompts: RecordedPrompt[] }> {
	const prompts: RecordedPrompt[] = [];
	const commands: RegisteredCommand[] = [];
	await registerV2AgentsAndCommands(
		{
			agent: {
				transform: async () => ({ dispose: async () => {} }),
				reload: async () => {},
			},
			command: {
				transform: async (
					cb: (e: { add(d: RegisteredCommand): void }) => void,
				) => {
					cb({
						add(d) {
							commands.push(d);
						},
					});
					return { dispose: async () => {} };
				},
				reload: async () => {},
			},
			session: {
				hook: async () => ({ dispose: async () => {} }),
				// 2.0.26 SessionApi shape: one object input (#3169).
				prompt: async (input: unknown) => {
					prompts.push(input as RecordedPrompt);
				},
			},
		} as never,
		hooks,
		canonicalMkdtemp('swarm-v2-cmddispatch-'),
		[],
	);
	return { commands, prompts };
}

function makeConfigHook(
	commandTable: Record<string, { template: string; description: string }>,
): V1HooksSubset['config'] {
	return async (cfg: Record<string, unknown>) => {
		cfg.command = commandTable;
	};
}

const EPIC_TABLE = {
	swarm: { template: '/swarm $ARGUMENTS', description: 'swarm' },
	'swarm-epic': {
		template: '/swarm epic $ARGUMENTS',
		description: 'swarm epic',
	},
};

describe('v2 command execute native dispatch (#3169 Phase 4)', () => {
	const savedXdg = process.env.XDG_CONFIG_HOME;

	beforeEach(() => {
		// The real epic handler loads user-level config through XDG_CONFIG_HOME;
		// isolate it so the config-gate refusal is deterministic on this machine.
		process.env.XDG_CONFIG_HOME = canonicalMkdtemp('swarm-v2-cmddispatch-xdg-');
	});

	afterEach(() => {
		if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = savedXdg;
	});

	test('a splicing command.execute.before is dispatched and its text submitted', async () => {
		const { commands, prompts } = await registerCommands({
			config: makeConfigHook(EPIC_TABLE),
			'command.execute.before': async (_input, output) => {
				output.parts.splice(0, output.parts.length, {
					type: 'text',
					text: 'DISPATCHED-OUTPUT',
				});
			},
		} as V1HooksSubset);
		const epic = commands.find((c) => c.name === 'swarm-epic');
		expect(epic).toBeDefined();
		await epic?.execute({ sessionID: 'ses-1', prompt: { text: 'start' } });
		expect(prompts.length).toBe(1);
		expect(prompts[0]).toEqual({
			sessionID: 'ses-1',
			text: 'DISPATCHED-OUTPUT',
		});
	});

	test('no command.execute.before on the hooks object falls back to the expanded template', async () => {
		const { commands, prompts } = await registerCommands({
			config: makeConfigHook(EPIC_TABLE),
		} as V1HooksSubset);
		const epic = commands.find((c) => c.name === 'swarm-epic');
		await epic?.execute({ sessionID: 'ses-2', prompt: { text: 'start' } });
		expect(prompts.length).toBe(1);
		expect(prompts[0]).toEqual({
			sessionID: 'ses-2',
			text: '/swarm epic start',
		});
	});

	test('a throwing hook falls back to the expanded template (v1-faithful degradation)', async () => {
		// Reachable only with an UNwrapped hook: production wraps the handler
		// in safeHook, which swallows throws into empty parts — the next
		// test's fallback arm.
		const { commands, prompts } = await registerCommands({
			config: makeConfigHook(EPIC_TABLE),
			'command.execute.before': async () => {
				throw new Error('handler exploded');
			},
		} as V1HooksSubset);
		const epic = commands.find((c) => c.name === 'swarm-epic');
		await epic?.execute({ sessionID: 'ses-3', prompt: { text: 'start' } });
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.text).toBe('/swarm epic start');
	});

	test('a hook that leaves parts empty falls back to the expanded template', async () => {
		const { commands, prompts } = await registerCommands({
			config: makeConfigHook(EPIC_TABLE),
			'command.execute.before': async () => {},
		} as V1HooksSubset);
		const epic = commands.find((c) => c.name === 'swarm-epic');
		await epic?.execute({ sessionID: 'ses-4', prompt: { text: 'start' } });
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.text).toBe('/swarm epic start');
	});

	test('the swarm-epic shortcut dispatches through the REAL v1 handler chain (gate-shaped)', async () => {
		const directory = canonicalMkdtemp('swarm-v2-cmddispatch-real-');
		const realHandler = createSwarmCommandHandler(directory, {}, {});
		const { commands, prompts } = await registerCommands({
			config: makeConfigHook(EPIC_TABLE),
			'command.execute.before': realHandler,
		} as unknown as V1HooksSubset);
		const epic = commands.find((c) => c.name === 'swarm-epic');
		await epic?.execute({ sessionID: 'ses-real-1', prompt: { text: 'start' } });
		expect(prompts.length).toBe(1);
		const text = prompts[0]?.text ?? '';
		// The canonical output envelope a v1 host produces for a human-typed
		// /swarm epic start, carrying the real registry outcome for a bare
		// project dir (config gate fires first).
		expect(text).toContain('The user typed `/swarm epic start`');
		expect(text).toContain('Canonical opencode-swarm command output follows');
		expect(text).toContain('epic-disabled-by-config');
		expect(text).not.toBe('/swarm epic start');
	});

	test('the main swarm command shape dispatches through the REAL handler chain too', async () => {
		const directory = canonicalMkdtemp('swarm-v2-cmddispatch-main-');
		const realHandler = createSwarmCommandHandler(directory, {}, {});
		const { commands, prompts } = await registerCommands({
			config: makeConfigHook(EPIC_TABLE),
			'command.execute.before': realHandler,
		} as unknown as V1HooksSubset);
		const main = commands.find((c) => c.name === 'swarm');
		await main?.execute({
			sessionID: 'ses-real-2',
			prompt: { text: 'epic start' },
		});
		expect(prompts.length).toBe(1);
		const text = prompts[0]?.text ?? '';
		expect(text).toContain('The user typed `/swarm epic start`');
		expect(text).toContain('epic-disabled-by-config');
		expect(text).not.toBe('/swarm epic start');
	});

	test('a host without the session prompt surface is a side-effect-free no-op (hook not invoked)', async () => {
		let hookInvocations = 0;
		const prompts: unknown[] = [];
		const commands: RegisteredCommand[] = [];
		await registerV2AgentsAndCommands(
			{
				agent: {
					transform: async () => ({ dispose: async () => {} }),
					reload: async () => {},
				},
				command: {
					transform: async (
						cb: (e: { add(d: RegisteredCommand): void }) => void,
					) => {
						cb({
							add(d) {
								commands.push(d);
							},
						});
						return { dispose: async () => {} };
					},
					reload: async () => {},
				},
				session: {
					hook: async () => ({ dispose: async () => {} }),
					// No prompt member at all.
				},
			} as never,
			{
				config: makeConfigHook(EPIC_TABLE),
				'command.execute.before': async () => {
					hookInvocations += 1;
				},
			} as V1HooksSubset,
			canonicalMkdtemp('swarm-v2-cmddispatch-noprompt-'),
			[],
		);
		const epic = commands.find((c) => c.name === 'swarm-epic');
		await epic?.execute({ sessionID: 'ses-5', prompt: { text: 'start' } });
		expect(prompts.length).toBe(0);
		expect(hookInvocations).toBe(0);
	});
});
