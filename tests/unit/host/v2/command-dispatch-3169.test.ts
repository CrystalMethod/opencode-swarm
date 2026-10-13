/**
 * Native /swarm command dispatch on the v2 execute path (#3169 Phase 4).
 *
 * The v2 CommandDefinition.execute must route through the shared v1 command
 * handler (command.execute.before on the hooks object — registry resolution,
 * policy refusals, real handler execution, canonical output envelope) and
 * submit the handler-produced prompt via ctx.session.prompt. The raw expanded
 * template survives only as the explicit fallback (absent hook / empty parts /
 * swallowed throw), and a host without a usable session prompt surface must
 * not run the registry handler at all (side-effect-free no-op). The dispatch
 * timeout arm submits a bounded notice — never the raw template (review
 * PRR-002; `_internals.dispatchTimeoutMs` makes the arm testable).
 *
 * Fakes only (no mock.module); the gate-shaped cases run the REAL
 * createSwarmCommandHandler + real registry in a bare canonicalMkdtemp project
 * with XDG_CONFIG_HOME isolated so the epic config-gate refusal
 * (epic-disabled-by-config) is the deterministic handler outcome.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { createSwarmCommandHandler } from '../../../../src/commands/index';
import {
	_internals,
	registerV2AgentsAndCommands,
} from '../../../../src/host/v2/agents-commands';
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

const tempDirs: string[] = [];

function trackedMkdtemp(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

/**
 * Register a command table through the real registerV2AgentsAndCommands
 * against a fake v2 ctx that records every ctx.session.prompt submission.
 */
async function registerCommands(
	hooks: V1HooksSubset,
	table: Record<string, { template: string; description: string }> = {
		swarm: { template: '/swarm $ARGUMENTS', description: 'swarm' },
		'swarm-epic': {
			template: '/swarm epic $ARGUMENTS',
			description: 'swarm epic',
		},
	},
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
		trackedMkdtemp('swarm-v2-cmddispatch-'),
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
	const savedBudget = _internals.dispatchTimeoutMs;

	beforeEach(() => {
		// The real epic handler loads user-level config through XDG_CONFIG_HOME;
		// isolate it so the config-gate refusal is deterministic on this machine.
		process.env.XDG_CONFIG_HOME = trackedMkdtemp('swarm-v2-cmddispatch-xdg-');
	});

	afterEach(() => {
		_internals.dispatchTimeoutMs = savedBudget;
		if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = savedXdg;
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a splicing command.execute.before is dispatched and its text submitted', async () => {
		let hookInvocations = 0;
		const { commands, prompts } = await registerCommands({
			config: makeConfigHook(EPIC_TABLE),
			'command.execute.before': async (_input, output) => {
				hookInvocations += 1;
				output.parts.splice(0, output.parts.length, {
					type: 'text',
					text: 'DISPATCHED-OUTPUT',
				});
			},
		} as V1HooksSubset);
		const epic = commands.find((c) => c.name === 'swarm-epic');
		expect(epic).toBeDefined();
		await epic?.execute({ sessionID: 'ses-1', prompt: { text: 'start' } });
		expect(hookInvocations).toBe(1);
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

	test('a throwing hook falls back to the expanded template after running', async () => {
		// Reachable only with an UNwrapped hook: production wraps the handler
		// in safeHook, which swallows throws into empty parts — the next
		// test's fallback arm. The invocation counter pins that the dispatch
		// RAN and degraded, rather than being skipped (review PRR-019).
		let hookInvocations = 0;
		const { commands, prompts } = await registerCommands({
			config: makeConfigHook(EPIC_TABLE),
			'command.execute.before': async () => {
				hookInvocations += 1;
				throw new Error('handler exploded');
			},
		} as V1HooksSubset);
		const epic = commands.find((c) => c.name === 'swarm-epic');
		await epic?.execute({ sessionID: 'ses-3', prompt: { text: 'start' } });
		expect(hookInvocations).toBe(1);
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.text).toBe('/swarm epic start');
	});

	test('a hook that leaves parts empty falls back to the expanded template after running', async () => {
		let hookInvocations = 0;
		const { commands, prompts } = await registerCommands({
			config: makeConfigHook(EPIC_TABLE),
			'command.execute.before': async () => {
				hookInvocations += 1;
			},
		} as V1HooksSubset);
		const epic = commands.find((c) => c.name === 'swarm-epic');
		await epic?.execute({ sessionID: 'ses-4', prompt: { text: 'start' } });
		expect(hookInvocations).toBe(1);
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.text).toBe('/swarm epic start');
	});

	test('the swarm-epic shortcut dispatches through the REAL v1 handler chain (gate-shaped)', async () => {
		const directory = trackedMkdtemp('swarm-v2-cmddispatch-real-');
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
		const directory = trackedMkdtemp('swarm-v2-cmddispatch-main-');
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

	test('production key shapes resolve through the seam: compound alias shortcut', async () => {
		// Review PRR-008: representative production shapes (main, simple
		// shortcut, compound alias) driven through the seam against the real
		// registry. The exhaustive per-key census lives in
		// src/commands/shortcut-resolution.test.ts + tests/unit/index-commands.test.ts.
		const directory = trackedMkdtemp('swarm-v2-cmddispatch-shapes-');
		const realHandler = createSwarmCommandHandler(directory, {}, {});
		const { commands, prompts } = await registerCommands({
			config: makeConfigHook({
				...EPIC_TABLE,
				// Production shape (src/index.ts): the template names a
				// DIFFERENT command than the key suffix; the key normalizes
				// to the deprecated 'plan' alias of 'show-plan'.
				'swarm-plan': {
					template: '/swarm show-plan $ARGUMENTS',
					description: 'plan shortcut',
				},
			}),
			'command.execute.before': realHandler,
		} as unknown as V1HooksSubset);
		const plan = commands.find((c) => c.name === 'swarm-plan');
		await plan?.execute({ sessionID: 'ses-shapes', prompt: { text: '3' } });
		expect(prompts.length).toBe(1);
		const text = prompts[0]?.text ?? '';
		// The key (not the template) drives dispatch — v1-parity — and the
		// alias resolves to a runnable handler (never a not-found).
		expect(text).toContain('The user typed `/swarm plan 3`');
		expect(text).not.toContain('not found');
	});

	test('a host without the session prompt surface is a side-effect-free no-op (hook not invoked)', async () => {
		let hookInvocations = 0;
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
			trackedMkdtemp('swarm-v2-cmddispatch-noprompt-'),
			[],
		);
		const epic = commands.find((c) => c.name === 'swarm-epic');
		await epic?.execute({ sessionID: 'ses-5', prompt: { text: 'start' } });
		expect(hookInvocations).toBe(0);
	});

	test('a non-function session prompt is the same side-effect-free no-op', async () => {
		// Review PRR-009: the no-submission assertions ride a recorder wired
		// into the fake ctx's neighborhood (a prompt member that exists but is
		// not callable), so the hook guard is the load-bearing pin and the
		// suite carries no disconnected assertion.
		let hookInvocations = 0;
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
					prompt: 'not-a-function' as never,
				} as never,
			} as never,
			{
				config: makeConfigHook(EPIC_TABLE),
				'command.execute.before': async () => {
					hookInvocations += 1;
				},
			} as V1HooksSubset,
			trackedMkdtemp('swarm-v2-cmddispatch-badprompt-'),
			[],
		);
		const epic = commands.find((c) => c.name === 'swarm-epic');
		await epic?.execute({ sessionID: 'ses-6', prompt: { text: 'start' } });
		expect(hookInvocations).toBe(0);
	});

	test('multiple text parts are joined, not truncated', async () => {
		const { commands, prompts } = await registerCommands({
			config: makeConfigHook(EPIC_TABLE),
			'command.execute.before': async (_input, output) => {
				output.parts.splice(
					0,
					output.parts.length,
					{ type: 'text', text: 'PART-ONE' },
					{ type: 'text', text: 'PART-TWO' },
				);
			},
		} as V1HooksSubset);
		const epic = commands.find((c) => c.name === 'swarm-epic');
		await epic?.execute({ sessionID: 'ses-7', prompt: { text: 'start' } });
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.text).toBe('PART-ONE\n\nPART-TWO');
	});

	test('a whitespace-only part is skipped: sole content falls back, later parts win', async () => {
		const { commands, prompts } = await registerCommands({
			config: makeConfigHook(EPIC_TABLE),
			'command.execute.before': async (_input, output) => {
				output.parts.splice(0, output.parts.length, {
					type: 'text',
					text: '   ',
				});
			},
		} as V1HooksSubset);
		const epic = commands.find((c) => c.name === 'swarm-epic');
		await epic?.execute({ sessionID: 'ses-8', prompt: { text: 'start' } });
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.text).toBe('/swarm epic start');

		const second = await registerCommands({
			config: makeConfigHook(EPIC_TABLE),
			'command.execute.before': async (_input, output) => {
				output.parts.splice(
					0,
					output.parts.length,
					{ type: 'text', text: '   ' },
					{ type: 'text', text: 'REAL' },
				);
			},
		} as V1HooksSubset);
		const epic2 = second.commands.find((c) => c.name === 'swarm-epic');
		await epic2?.execute({ sessionID: 'ses-8b', prompt: { text: 'start' } });
		expect(second.prompts[0]?.text).toBe('REAL');
	});

	test('malformed and foreign-typed parts are skipped, never thrown on', async () => {
		const { commands, prompts } = await registerCommands({
			config: makeConfigHook(EPIC_TABLE),
			'command.execute.before': async (_input, output) => {
				output.parts.splice(
					0,
					output.parts.length,
					null,
					'a bare string part',
					{ type: 'text', text: 123 },
					{ type: 'tool_result', text: 'SHOULD-NOT-SURFACE' },
					{ type: 'text', text: 'REAL' },
				);
			},
		} as unknown as V1HooksSubset);
		const epic = commands.find((c) => c.name === 'swarm-epic');
		await epic?.execute({ sessionID: 'ses-9', prompt: { text: 'start' } });
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.text).toBe('REAL');
	});

	test('an empty-string part is skipped in favor of a later real part', async () => {
		const { commands, prompts } = await registerCommands({
			config: makeConfigHook(EPIC_TABLE),
			'command.execute.before': async (_input, output) => {
				output.parts.splice(
					0,
					output.parts.length,
					{ type: 'text', text: '' },
					{ type: 'text', text: 'REAL' },
				);
			},
		} as V1HooksSubset);
		const epic = commands.find((c) => c.name === 'swarm-epic');
		await epic?.execute({ sessionID: 'ses-10', prompt: { text: 'start' } });
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.text).toBe('REAL');
	});

	test('a fixed template (no $ARGUMENTS) preserves typed arguments in the fallback', async () => {
		// Review PRR-003a: production registers fixed templates like
		// 'swarm-config-doctor' -> '/swarm config doctor'; the fallback must
		// not silently drop what the user typed.
		const { commands, prompts } = await registerCommands({
			config: makeConfigHook({
				'swarm-config-doctor': {
					template: '/swarm config doctor',
					description: 'config doctor shortcut',
				},
			}),
		} as V1HooksSubset);
		const doctor = commands.find((c) => c.name === 'swarm-config-doctor');
		await doctor?.execute({ sessionID: 'ses-11', prompt: { text: '--fix' } });
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.text).toBe('/swarm config doctor --fix');
	});

	test('a dispatch timeout submits the bounded notice, never the raw template', async () => {
		// Review PRR-002: the timeout arm via the injectable budget. The
		// notice text derives from _internals.dispatchTimeoutMs (0.05s here),
		// pinning that the notice — not the raw template — is submitted and
		// that the identity-routed arm (not the generic throw arm) fired.
		_internals.dispatchTimeoutMs = 50;
		const { commands, prompts } = await registerCommands({
			config: makeConfigHook(EPIC_TABLE),
			'command.execute.before': async () => new Promise(() => {}),
		} as V1HooksSubset);
		const epic = commands.find((c) => c.name === 'swarm-epic');
		await epic?.execute({ sessionID: 'ses-12', prompt: { text: 'start' } });
		expect(prompts.length).toBe(1);
		const text = prompts[0]?.text ?? '';
		expect(
			text.startsWith(
				'[opencode-swarm] v2: command swarm-epic dispatch exceeded',
			),
		).toBe(true);
		expect(text).toContain('0.05s budget');
		expect(text).not.toBe('/swarm epic start');
	});
});
