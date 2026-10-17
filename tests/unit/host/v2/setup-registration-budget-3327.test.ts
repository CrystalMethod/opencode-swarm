import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { clearV2AgentTransformSurface } from '../../../../src/host/v2/model-apply';
import { openCodeSwarmV2Setup } from '../../../../src/host/v2/setup';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../../src/services/warning-buffer';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

/**
 * #3327 review feedback: the v2 registration stage runs its five domains in
 * parallel under ONE 3.5 s budget (V2_REGISTRATION_TIMEOUT_MS) while init /
 * cleanup / tail preflight use the generous V2_SETUP_TIMEOUT_MS (60 s). A
 * stalled domain must not hold setup() open; it is named in a deferred warning,
 * and a registration that lands after cleanup started is disposed on arrival.
 */

const PARTIAL = 'partial registration';

interface Spy {
	dispose: () => Promise<void>;
	calls: number;
}

function makeRegistration(): Spy {
	const reg: Spy = {
		calls: 0,
		dispose: async () => {
			reg.calls += 1;
		},
	};
	return reg;
}

interface FakeCtxOptions {
	/** Override the tool.transform behavior (default: resolve a registration). */
	toolTransform?: () => Promise<unknown>;
	/** Override the command.transform behavior. */
	commandTransform?: () => Promise<unknown>;
	/** Override the tool.hook behavior (default: resolve a registration). */
	toolHook?: () => Promise<unknown>;
}

function buildCtx(directory: string, opts: FakeCtxOptions = {}) {
	const registrations: Spy[] = [];
	const counts = { agent: 0, command: 0, tool: 0, toolHook: 0, sessionHook: 0 };
	const reg = (): Spy => {
		const r = makeRegistration();
		registrations.push(r);
		return r;
	};
	const editor = { update: () => {}, remove: () => {}, list: () => [] };
	const ctx = {
		location: { directory },
		agent: {
			transform: async (fn: (e: unknown) => void) => {
				counts.agent += 1;
				fn(editor);
				return reg();
			},
		},
		command: {
			transform: async (fn: (e: unknown) => void) => {
				counts.command += 1;
				if (opts.commandTransform) return opts.commandTransform();
				fn({ add: () => {} });
				return reg();
			},
		},
		tool: {
			transform: (fn: (e: unknown) => void) => {
				counts.tool += 1;
				if (opts.toolTransform) return opts.toolTransform();
				fn({ add: () => {} });
				return Promise.resolve(reg());
			},
			hook: async () => {
				counts.toolHook += 1;
				if (opts.toolHook) return opts.toolHook();
				return reg();
			},
		},
		session: {
			hook: async () => {
				counts.sessionHook += 1;
				return reg();
			},
		},
		event: {},
	};
	return { ctx, counts, registrations };
}

// hooks.config must exist or agents-commands registration returns early.
const makeHooks = () =>
	({
		config: (c: Record<string, unknown>) => {
			c.agent = {};
			c.command = {};
		},
	}) as never;

const partialWarnings = () =>
	getDeferredWarnings().filter((w) => w.includes(PARTIAL));

let dir: string;

beforeEach(() => {
	clearDeferredWarnings();
	dir = canonicalMkdtemp('v2-reg-budget-3327-');
});

afterEach(() => {
	clearV2AgentTransformSurface();
	clearDeferredWarnings();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('#3327 registration budget: stalled domain', () => {
	test('a never-settling registration resolves setup within ~3.5s, others land, warning names the domain', async () => {
		const { ctx, counts } = buildCtx(dir, {
			toolTransform: () => new Promise<never>(() => {}),
		});
		const start = performance.now();
		const cleanup = await openCodeSwarmV2Setup(ctx as never, {
			runInit: async () => makeHooks(),
		});
		const elapsed = performance.now() - start;

		expect(elapsed).toBeGreaterThanOrEqual(3000);
		expect(elapsed).toBeLessThan(6000);
		expect(typeof cleanup).toBe('function');
		// Every other domain registered despite the stalled one.
		expect(counts.agent).toBe(1);
		expect(counts.command).toBe(1);
		expect(counts.tool).toBe(1);
		expect(counts.toolHook).toBe(2);
		expect(counts.sessionHook).toBe(3);

		const warnings = partialWarnings();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('(tool)');
		expect(warnings[0]).toContain('3500ms');
		// Settled domains are not blamed.
		expect(warnings[0]).not.toContain('context-hook');
		expect(warnings[0]).not.toContain('tool-hook');
		expect(warnings[0]).not.toContain('prompt-hook');
		expect(warnings[0]).not.toContain('agent/command');
		await cleanup();
	}, 15_000);

	test('several stalled domains are all named, in registration order, in one warning', async () => {
		const { ctx } = buildCtx(dir, {
			toolTransform: () => new Promise<never>(() => {}),
			toolHook: () => new Promise<never>(() => {}),
		});
		const cleanup = await openCodeSwarmV2Setup(ctx as never, {
			runInit: async () => makeHooks(),
		});
		const warnings = partialWarnings();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('(tool, tool-hook)');
		expect(warnings[0]).not.toContain('context-hook');
		expect(warnings[0]).not.toContain('prompt-hook');
		expect(warnings[0]).not.toContain('agent/command');
		await cleanup();
	}, 15_000);

	test('a registration landing after budget AND after cleanup is disposed on arrival', async () => {
		let release!: (r: Spy) => void;
		const gate = new Promise<Spy>((resolve) => {
			release = resolve;
		});
		const { ctx, registrations } = buildCtx(dir, {
			toolTransform: () => gate,
		});
		const cleanup = await openCodeSwarmV2Setup(ctx as never, {
			runInit: async () => makeHooks(),
		});
		expect(partialWarnings()).toHaveLength(1);

		await cleanup();
		// Everything that registered in time was disposed exactly once.
		expect(registrations.length).toBe(1 + 1 + 2 + 3);
		for (const r of registrations) expect(r.calls).toBe(1);

		const late = makeRegistration();
		expect(late.calls).toBe(0);
		release(late);
		// Late dispose is scheduled through a microtask + withTimeout.
		for (let i = 0; i < 50 && late.calls === 0; i++) await Bun.sleep(10);
		expect(late.calls).toBe(1);
		// Not double-disposed after settling.
		await Bun.sleep(30);
		expect(late.calls).toBe(1);
	}, 15_000);

	test('a late registration whose dispose throws does not surface as an unhandled rejection', async () => {
		let release!: (r: unknown) => void;
		const gate = new Promise<unknown>((resolve) => {
			release = resolve;
		});
		const { ctx } = buildCtx(dir, { toolTransform: () => gate });
		const cleanup = await openCodeSwarmV2Setup(ctx as never, {
			runInit: async () => makeHooks(),
		});
		await cleanup();
		const seen: unknown[] = [];
		const onRej = (e: unknown) => seen.push(e);
		process.on('unhandledRejection', onRej);
		try {
			let attempts = 0;
			release({
				dispose: async () => {
					attempts += 1;
					throw new Error('boom-late-dispose');
				},
			});
			for (let i = 0; i < 50 && attempts === 0; i++) await Bun.sleep(10);
			await Bun.sleep(30);
			expect(attempts).toBe(1);
			expect(seen).toEqual([]);
		} finally {
			process.off('unhandledRejection', onRej);
		}
	}, 15_000);
});

describe('#3327 registration budget: per-domain isolation', () => {
	test('a rejecting domain does not block others; cleanup disposes the successes', async () => {
		const { ctx, counts, registrations } = buildCtx(dir, {
			commandTransform: async () => {
				throw new Error('command boom');
			},
		});
		const start = performance.now();
		const cleanup = await openCodeSwarmV2Setup(ctx as never, {
			runInit: async () => makeHooks(),
		});
		// Rejection is isolated, not a budget expiry.
		expect(performance.now() - start).toBeLessThan(2500);
		expect(typeof cleanup).toBe('function');
		expect(counts.command).toBe(1);
		expect(counts.tool).toBe(1);
		expect(counts.toolHook).toBe(2);
		expect(counts.sessionHook).toBe(3);
		expect(partialWarnings()).toEqual([]);

		// agent + tool + 2 tool-hooks + 3 session hooks (command never produced one)
		expect(registrations.length).toBe(1 + 1 + 2 + 3);
		for (const r of registrations) expect(r.calls).toBe(0);
		await cleanup();
		for (const r of registrations) expect(r.calls).toBe(1);
	}, 15_000);

	test('a rejecting domain does not cut short a slower sibling (setup waits for it)', async () => {
		const slow = makeRegistration();
		const { ctx, counts, registrations } = buildCtx(dir, {
			commandTransform: async () => {
				throw new Error('command boom');
			},
			// Lands well after the fast rejection but well inside the 3.5s budget.
			toolTransform: () =>
				new Promise<Spy>((resolve) => setTimeout(() => resolve(slow), 150)),
		});
		const cleanup = await openCodeSwarmV2Setup(ctx as never, {
			runInit: async () => makeHooks(),
		});
		// The slow sibling had finished by the time setup resolved (not abandoned
		// as 'pending'): no partial-registration warning, and cleanup disposes it
		// exactly once (it was tracked, not disposed as a late arrival).
		expect(counts.tool).toBe(1);
		expect(partialWarnings()).toEqual([]);
		expect(slow.calls).toBe(0);
		await cleanup();
		expect(slow.calls).toBe(1);
		for (const r of registrations) expect(r.calls).toBe(1);
		await Bun.sleep(30);
		expect(slow.calls).toBe(1);
	}, 15_000);
});

describe('#3327 runInit budget (60s, not 3.5s)', () => {
	test('a 4000ms runInit now succeeds', async () => {
		const { ctx } = buildCtx(dir);
		const start = performance.now();
		const cleanup = await openCodeSwarmV2Setup(ctx as never, {
			runInit: async () => {
				await Bun.sleep(4000);
				return makeHooks();
			},
		});
		expect(performance.now() - start).toBeGreaterThanOrEqual(3900);
		expect(typeof cleanup).toBe('function');
		expect(partialWarnings()).toEqual([]);
		await cleanup();
	}, 15_000);

	test('a rejecting runInit rejects setup with that error and registers nothing', async () => {
		const { ctx, counts } = buildCtx(dir);
		const err = new Error('init exploded');
		await expect(
			openCodeSwarmV2Setup(ctx as never, {
				runInit: async () => {
					throw err;
				},
			}),
		).rejects.toBe(err);
		expect(counts).toEqual({
			agent: 0,
			command: 0,
			tool: 0,
			toolHook: 0,
			sessionHook: 0,
		});
	});
});

describe('#3327 source contract', () => {
	const src = fs.readFileSync(
		path.resolve(import.meta.dir, '../../../../src/host/v2/setup.ts'),
		'utf-8',
	);

	test('budget constants', () => {
		expect(src).toContain('const V2_SETUP_TIMEOUT_MS = 60_000;');
		expect(src).toContain('const V2_REGISTRATION_TIMEOUT_MS = 3_500;');
		expect(src).toContain('const V2_PREFLIGHT_CONFIG_TIMEOUT_MS = 2_000;');
	});

	test('preflight uses the async config loader only', () => {
		const start = src.indexOf('async function deferredV2StartupModelPreflight');
		const end = src.indexOf('export interface V2SetupDependencies');
		expect(start).toBeGreaterThanOrEqual(0);
		const body = src.slice(start, end);
		expect(body).toContain('loadPluginConfigWithMetaAsync(directory)');
		expect(body).toContain('V2_PREFLIGHT_CONFIG_TIMEOUT_MS');
		// \b: the sync name must not appear (Async variant is a different word).
		expect(src).not.toMatch(/\bloadPluginConfigWithMeta\b/);
	});

	test('registration Promise.all is wrapped by withTimeout with the registration budget', () => {
		expect(src).toMatch(
			/withTimeout\(\s*Promise\.all\(\[[\s\S]*?\]\),\s*V2_REGISTRATION_TIMEOUT_MS,/,
		);
		// init stays on the generous budget, not the registration one.
		expect(src).toMatch(
			/withTimeout\(\s*deps\.runInit\(input\),\s*V2_SETUP_TIMEOUT_MS,/,
		);
	});

	test('tail preflight and every dispose path stay on the generous budget', () => {
		// tail preflight wrap
		expect(src).toMatch(
			/withTimeout\(\s*deferredV2StartupModelPreflight\(directory\),\s*V2_SETUP_TIMEOUT_MS,/,
		);
		// late-registration dispose (sink), per-registration dispose, v1 dispose
		expect(src).toMatch(
			/Promise\.resolve\(\)\.then\(\(\) => item\.dispose\(\)\),\s*V2_SETUP_TIMEOUT_MS,/,
		);
		expect(src).toMatch(
			/withTimeout\(\s*registration\.dispose\(\),\s*V2_SETUP_TIMEOUT_MS,/,
		);
		expect(src).toMatch(
			/withTimeout\(\s*state\.disposeV1\(\),\s*V2_SETUP_TIMEOUT_MS,/,
		);
		// the 3.5s registration budget is used by exactly one withTimeout stage
		const uses = src.match(/V2_REGISTRATION_TIMEOUT_MS,/g) ?? [];
		expect(uses.length).toBe(1);
	});
});
