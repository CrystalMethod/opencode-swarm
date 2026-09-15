/**
 * Conservative preset tests (issue #2504, governed v8 defaults-flip frame).
 *
 * Pins the preset contract frozen by the #2504 acceptance checks:
 *  - schema: top-level `preset` is preserved ('default' | 'conservative'),
 *    anything else is a schema error;
 *  - loader: a project config selecting `preset: "conservative"` materializes
 *    the v7 value (`auto_review.enabled: false`) through the production
 *    resolution path, while an explicit user/project key always wins —
 *    including partial sections like `auto_review: { mode: "gate" }`;
 *  - release seam: `resolveAutoReviewConfig` keeps auto-review disabled at a
 *    simulated v8 package version under the conservative preset;
 *  - save_plan: new plans default to serial under conservative, parallel-first
 *    otherwise, explicit profile keys always win, and a config-load failure
 *    fails open to the v8 default.
 *
 * New file (FR-006): src/services/config-doctor.test.ts and the save-plan
 * suites are over the 500-line cap; this contract gets its own file.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigLoadResult } from '../../../src/config/loader';
import { loadPluginConfig } from '../../../src/config/loader';
import {
	AUTO_REVIEW_V8_BURN_IN_DECISION,
	CONSERVATIVE_PRESET_BASE,
	PluginConfigSchema,
	resolveAutoReviewConfig,
} from '../../../src/config/schema';
import { loadPlanJsonOnly } from '../../../src/plan/manager';
import {
	executeSavePlan,
	_internals as savePlanInternals,
} from '../../../src/tools/save-plan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const PROJECT_CONFIG = '.opencode/opencode-swarm.json';

let xdgDir: string;
let originalXDG: string | undefined;

beforeEach(() => {
	// Isolate the USER config path so the developer's real user-level
	// opencode-swarm.json cannot leak into loader-dependent assertions.
	xdgDir = canonicalMkdtemp('conservative-preset-xdg-');
	originalXDG = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = xdgDir;
});

afterEach(() => {
	if (originalXDG === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = originalXDG;
	}
	fs.rmSync(xdgDir, { recursive: true, force: true });
});

/** Write a project config and return its directory. */
function writeProject(config: unknown): string {
	const dir = canonicalMkdtemp('conservative-preset-proj-');
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, PROJECT_CONFIG),
		JSON.stringify(config),
		'utf-8',
	);
	return dir;
}

describe('conservative preset — schema surface (#2504)', () => {
	test('preserves preset: "conservative" through PluginConfigSchema.parse', () => {
		const parsed = PluginConfigSchema.parse({ preset: 'conservative' });
		expect(parsed.preset).toBe('conservative');
	});

	test('preserves preset: "default"', () => {
		const parsed = PluginConfigSchema.parse({ preset: 'default' });
		expect(parsed.preset).toBe('default');
	});

	test('absent preset stays undefined (existing configs untouched)', () => {
		const parsed = PluginConfigSchema.parse({});
		expect(parsed.preset).toBeUndefined();
	});

	test('rejects an unknown preset value', () => {
		const result = PluginConfigSchema.safeParse({ preset: 'turbo-ultra' });
		expect(result.success).toBe(false);
	});

	test('CONSERVATIVE_PRESET_BASE pins the v7 auto_review posture', () => {
		const base = CONSERVATIVE_PRESET_BASE as {
			auto_review?: { enabled?: boolean };
		};
		expect(base.auto_review?.enabled).toBe(false);
	});
});

describe('conservative preset — loader materialization (#2504)', () => {
	test('conservative project config resolves auto_review.enabled === false', () => {
		const dir = writeProject({ preset: 'conservative' });
		const config = loadPluginConfig(dir);
		expect(config.preset).toBe('conservative');
		expect(config.auto_review?.enabled).toBe(false);
	});

	test('conservative preset survives an agents block (installer shape)', () => {
		// Final-critic round 1: the v6.12 dormant-legacy-key strip used to
		// delete `preset` whenever an `agents` block existed — silently
		// disabling the conservative preset for the exact config shape the
		// installer writes (src/cli/index.ts default config).
		const dir = writeProject({
			preset: 'conservative',
			agents: { coder: { model: 'opencode/big-pickle' } },
		});
		const config = loadPluginConfig(dir);
		expect(config.preset).toBe('conservative');
		expect(config.auto_review?.enabled).toBe(false);
		expect(config.agents?.coder?.model).toBe('opencode/big-pickle');
	});

	test('conservative preset survives an EMPTY agents block', () => {
		const dir = writeProject({ preset: 'conservative', agents: {} });
		const config = loadPluginConfig(dir);
		expect(config.preset).toBe('conservative');
		expect(config.auto_review?.enabled).toBe(false);
	});

	test('a legacy v6.12 preset NAME is still stripped next to an agents block', () => {
		// The dormant strip must keep firing for actual legacy values
		// (arbitrary remote-preset names) — the fix must not wedge it shut.
		const dir = writeProject({
			preset: 'remote',
			presets: { remote: { coder: { model: 'x' } } },
			agents: {},
		});
		const config = loadPluginConfig(dir);
		expect(config.preset).toBeUndefined();
	});

	test('explicit auto_review.enabled: true beats the preset', () => {
		const dir = writeProject({
			preset: 'conservative',
			auto_review: { enabled: true },
		});
		const config = loadPluginConfig(dir);
		expect(config.auto_review?.enabled).toBe(true);
	});

	test('partial auto_review section keeps user keys and the v7 enabled default', () => {
		const dir = writeProject({
			preset: 'conservative',
			auto_review: { mode: undefined, structured_findings: false },
		});
		const config = loadPluginConfig(dir);
		// The base layer fills enabled=false; the user's other keys survive.
		expect(config.auto_review?.enabled).toBe(false);
		expect(config.auto_review?.structured_findings).toBe(false);
	});

	test('no preset (v7-era config) keeps the section absent', () => {
		const dir = writeProject({ automation: { mode: 'manual' } });
		const config = loadPluginConfig(dir);
		expect(config.preset).toBeUndefined();
		expect(config.auto_review).toBeUndefined();
	});
});

describe('conservative preset — release seam (#2504)', () => {
	const v8Context = {
		packageVersion: '8.0.0',
		burnInDecision: AUTO_REVIEW_V8_BURN_IN_DECISION,
	};

	test('conservative keeps auto_review disabled at a simulated v8 release', () => {
		const config = resolveAutoReviewConfig(
			{},
			{ ...v8Context, preset: 'conservative' },
		);
		expect(config.enabled).toBe(false);
	});

	test('no preset flips auto_review on at a simulated v8 release', () => {
		const config = resolveAutoReviewConfig({}, v8Context);
		expect(config.enabled).toBe(true);
	});

	test('explicit enabled: false stays authoritative at v8 (kill switch)', () => {
		const config = resolveAutoReviewConfig({ enabled: false }, v8Context);
		expect(config.enabled).toBe(false);
	});
});

describe('conservative preset — save_plan new-plan default (#2504)', () => {
	let tempDir: string;
	let swarmDir: string;
	let originalLoader: typeof savePlanInternals.loadPluginConfigWithMeta;

	beforeEach(() => {
		process.env.SWARM_SKIP_GATE_SELECTION = '1';
		tempDir = canonicalMkdtemp('conservative-preset-plan-');
		swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'spec.md'),
			'# Test Spec\nconservative preset save_plan spec.',
			'utf-8',
		);
		fs.writeFileSync(
			path.join(swarmDir, 'context.md'),
			'## Pending QA Gate Selection\n',
			'utf-8',
		);
		originalLoader = savePlanInternals.loadPluginConfigWithMeta;
	});

	afterEach(() => {
		delete process.env.SWARM_SKIP_GATE_SELECTION;
		savePlanInternals.loadPluginConfigWithMeta = originalLoader;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function fakeLoader(preset: string | undefined) {
		return ((directory: string) =>
			({
				config: PluginConfigSchema.parse(preset ? { preset } : {}),
			}) as unknown as ConfigLoadResult) as typeof savePlanInternals.loadPluginConfigWithMeta;
	}

	function makePlanArgs(): Parameters<typeof executeSavePlan>[0] {
		return {
			title: 'Conservative Plan',
			swarm_id: 'test-swarm',
			working_directory: tempDir,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [{ id: '1.1', description: 'Task 1.1' }],
				},
			],
		};
	}

	test('new plan defaults to serial under the conservative preset', async () => {
		savePlanInternals.loadPluginConfigWithMeta = fakeLoader('conservative');
		const result = await executeSavePlan(makePlanArgs());
		expect(result.success).toBe(true);
		const loaded = await loadPlanJsonOnly(tempDir);
		expect(loaded?.execution_profile?.parallelization_enabled).toBe(false);
	});

	test('new plan keeps the v8 parallel-first default without the preset', async () => {
		savePlanInternals.loadPluginConfigWithMeta = fakeLoader(undefined);
		const result = await executeSavePlan(makePlanArgs());
		expect(result.success).toBe(true);
		const loaded = await loadPlanJsonOnly(tempDir);
		expect(loaded?.execution_profile?.parallelization_enabled).toBe(true);
	});

	test('explicit execution_profile.parallelization_enabled beats the preset', async () => {
		savePlanInternals.loadPluginConfigWithMeta = fakeLoader('conservative');
		const args = makePlanArgs();
		args.execution_profile = { parallelization_enabled: true };
		const result = await executeSavePlan(args);
		expect(result.success).toBe(true);
		const loaded = await loadPlanJsonOnly(tempDir);
		expect(loaded?.execution_profile?.parallelization_enabled).toBe(true);
	});

	test('config-load failure fails open to the v8 default', async () => {
		savePlanInternals.loadPluginConfigWithMeta = (() => {
			throw new Error('simulated config-load failure');
		}) as unknown as typeof savePlanInternals.loadPluginConfigWithMeta;
		const result = await executeSavePlan(makePlanArgs());
		expect(result.success).toBe(true);
		const loaded = await loadPlanJsonOnly(tempDir);
		expect(loaded?.execution_profile?.parallelization_enabled).toBe(true);
	});
});
