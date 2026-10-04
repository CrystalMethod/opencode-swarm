/**
 * Epic v2 C6 — config: the Epic v1 `turbo.epic.calibration` block is retired
 * by accept-and-strip (the whole block — `enabled`, `floor_threshold`,
 * `tighten_step`, `loosen_step`, `loosen_window` — has no effect: learning
 * replaced it; `calibration.enabled` deliberately does NOT map to
 * `learning.enabled`), and the new strict `turbo.epic.learning.*` keys
 * validate with their defaults.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildConfigJsonSchema } from '../../../scripts/generate-config-schema';
import {
	_internals,
	loadPluginConfigWithMeta,
} from '../../../src/config/loader';
import {
	EpicConfigSchema,
	findRetiredEpicConfigKeys,
	PluginConfigSchema,
} from '../../../src/config/schema';
import { runConfigDoctor } from '../../../src/services/config-doctor';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { resolveEpicLearningSettings } from '../../../src/turbo/epic/learning';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let sandbox: string;
let projectDir: string;
let originalXdg: string | undefined;

const V1_CONFIG = {
	turbo: {
		strategy: 'standard',
		epic: {
			mode: { enabled: true },
			calibration: {
				enabled: false,
				floor_threshold: 0.1,
				tighten_step: 0.05,
				loosen_step: 0.02,
				loosen_window: 5,
			},
			sizing: { min_tasks: 3 },
		},
	},
};

beforeEach(() => {
	sandbox = canonicalMkdtemp('epic-learning-config-');
	projectDir = path.join(sandbox, 'repo');
	fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true });
	originalXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = path.join(sandbox, 'xdg-empty');
	fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
	clearDeferredWarnings();
	_internals.resetRetiredEpicKeyWarning();
});

afterEach(() => {
	if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXdg;
	fs.rmSync(sandbox, { recursive: true, force: true });
	clearDeferredWarnings();
	_internals.resetRetiredEpicKeyWarning();
});

describe('turbo.epic.calibration — retired (accept-and-strip)', () => {
	it('the whole block is stripped; the rest of the epic block is kept', () => {
		const parsed = PluginConfigSchema.parse(V1_CONFIG);
		expect(parsed.turbo?.epic?.mode?.enabled).toBe(true);
		expect(parsed.turbo?.epic?.sizing?.min_tasks).toBe(3);
		expect(Object.hasOwn(parsed.turbo?.epic ?? {}, 'calibration')).toBe(false);
		// calibration.enabled: false does not disable learning (no alias).
		expect(resolveEpicLearningSettings(parsed).enabled).toBe(true);
	});

	it('the epic object stays strict for everything else', () => {
		expect(EpicConfigSchema.safeParse({ calibrashun: {} }).success).toBe(false);
	});

	it('findRetiredEpicConfigKeys names the block', () => {
		expect(findRetiredEpicConfigKeys(V1_CONFIG)).toEqual([
			'turbo.epic.calibration',
		]);
	});

	it('the loader keeps the turbo block, recovers nothing, and warns once with the replacement', () => {
		fs.writeFileSync(
			path.join(projectDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(V1_CONFIG),
		);
		const loaded = loadPluginConfigWithMeta(projectDir);
		expect(loaded.recovery).toBe('none');
		expect(loaded.removedKeys).toEqual([]);
		expect(loaded.config.turbo?.epic?.sizing?.min_tasks).toBe(3);
		loadPluginConfigWithMeta(projectDir);
		const warnings = getDeferredWarnings().filter((w) =>
			w.includes('retired Epic config key'),
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('turbo.epic.calibration');
		expect(warnings[0]).toContain('turbo.epic.learning');
	});

	it('the config doctor reports it with the replacement', () => {
		fs.writeFileSync(
			path.join(projectDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(V1_CONFIG),
		);
		const { config } = loadPluginConfigWithMeta(projectDir);
		const retired = runConfigDoctor(config, projectDir).findings.filter(
			(f) => f.id === 'retired-config-key',
		);
		expect(retired.map((f) => f.path)).toEqual(['turbo.epic.calibration']);
		expect(retired[0]?.description).toContain('turbo.epic.learning');
	});

	it('the JSON schema keeps it, marked deprecated, in both turbo branches', () => {
		const text = JSON.stringify(buildConfigJsonSchema());
		expect(text.match(/"calibration":\{"deprecated":true/g)?.length).toBe(2);
	});
});

describe('turbo.epic.learning — new strict keys', () => {
	it('defaults', () => {
		expect(EpicConfigSchema.parse({ learning: {} }).learning).toEqual({
			enabled: true,
			decay_per_epic: 0.7,
			half_life_days: 60,
			hot_excess: 0.25,
		});
		expect(resolveEpicLearningSettings(undefined)).toEqual({
			enabled: true,
			decayPerEpic: 0.7,
			halfLifeDays: 60,
			hotExcess: 0.25,
		});
	});

	it('resolves configured values', () => {
		const config = PluginConfigSchema.parse({
			turbo: {
				strategy: 'standard',
				epic: {
					learning: {
						enabled: false,
						decay_per_epic: 0.5,
						half_life_days: 30,
						hot_excess: 0.4,
					},
				},
			},
		});
		expect(resolveEpicLearningSettings(config)).toEqual({
			enabled: false,
			decayPerEpic: 0.5,
			halfLifeDays: 30,
			hotExcess: 0.4,
		});
	});

	it('rejects unknown keys and out-of-range values', () => {
		for (const learning of [
			{ typo: 1 },
			{ decay_per_epic: 1.5 },
			{ half_life_days: 0 },
			{ hot_excess: -0.1 },
		]) {
			expect(EpicConfigSchema.safeParse({ learning }).success).toBe(false);
		}
	});

	it('the JSON schema lists the learning keys', () => {
		const text = JSON.stringify(buildConfigJsonSchema());
		for (const key of ['decay_per_epic', 'half_life_days', 'hot_excess']) {
			expect(text).toContain(`"${key}"`);
		}
	});
});
