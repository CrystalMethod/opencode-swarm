/**
 * Config-doctor coverage for the `sdd` key. validateConfigKey is module-private,
 * so it is exercised through runConfigDoctor (which walks the config object).
 *
 * A bad `sdd.source` LEAF is reported by the doctor's raw-file collectors from
 * the schema enum and dropped from the parsed config by the loader recovery
 * ladder, so it must be driven through a REAL `.opencode/opencode-swarm.json`
 * (a hand-built parsed object can never carry an invalid value in production).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPluginConfigWithMeta } from '../../../src/config/loader';
import type { PluginConfig } from '../../../src/config/schema';
import {
	type ConfigFinding,
	runConfigDoctor,
} from '../../../src/services/config-doctor';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;
let savedXdg: string | undefined;

beforeEach(() => {
	tempDir = canonicalMkdtemp('config-doctor-sdd-');
	savedXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = path.join(tempDir, '.xdg-config');
});

afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = savedXdg;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeProject(content: unknown): void {
	const abs = path.join(tempDir, '.opencode', 'opencode-swarm.json');
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, JSON.stringify(content), 'utf-8');
}

function sddFindings(sdd: unknown): ConfigFinding[] {
	const config = (sdd === undefined ? {} : { sdd }) as unknown as PluginConfig;
	return runConfigDoctor(config, tempDir).findings.filter(
		(f) =>
			f.path === 'sdd' || f.path.startsWith('sdd.') || f.id.includes('sdd'),
	);
}

describe('config-doctor: sdd', () => {
	test('control: a different key with a bad type still yields findings (harness is not vacuous)', () => {
		const result = runConfigDoctor(
			{ hooks: 'nope' } as unknown as PluginConfig,
			tempDir,
		);
		expect(result.findings.some((f) => f.id === 'invalid-hooks-type')).toBe(
			true,
		);
	});

	for (const [name, value] of [
		['string', 'openspec'],
		['number', 7],
		['array', ['openspec']],
		['boolean', true],
	] as const) {
		test(`non-object sdd (${name}) => invalid-sdd-type error finding`, () => {
			const f = sddFindings(value).find((x) => x.id === 'invalid-sdd-type');
			expect(f).toBeDefined();
			expect(f?.severity).toBe('error');
			expect(f?.path).toBe('sdd');
			expect(f?.autoFixable).toBe(false);
		});
	}

	for (const source of ['openspec', 'speckit', 'swarm']) {
		test(`valid source ${source} => no sdd findings`, () => {
			expect(sddFindings({ source })).toEqual([]);
		});
	}

	test('empty sdd object => no findings', () => {
		expect(sddFindings({})).toEqual([]);
	});

	test('sdd absent => no findings', () => {
		expect(sddFindings(undefined)).toEqual([]);
	});

	test('sdd.source explicitly undefined => no findings', () => {
		expect(sddFindings({ source: undefined })).toEqual([]);
	});
});

describe('config-doctor: a REAL .opencode file with a bad sdd.source', () => {
	for (const bad of ['Speckit', 'bogus', 42]) {
		test(`source ${JSON.stringify(bad)}: loader drops only that leaf, doctor names sdd.source`, () => {
			writeProject({ sdd: { source: bad }, max_iterations: 7 });
			const meta = loadPluginConfigWithMeta(tempDir);
			// Recovery ladder drops ONLY the bad leaf: the rest of the config
			// survives (a typo must not cascade into safe-defaults).
			expect(meta.config.sdd?.source).toBeUndefined();
			expect(meta.config.max_iterations).toBe(7);

			const findings = runConfigDoctor(meta.config, tempDir).findings.filter(
				(f) => f.path === 'sdd.source',
			);
			expect(findings).toHaveLength(1);
			expect(findings[0]?.id).toBe('invalid-config-value');
			expect(findings[0]?.severity).toBe('error');
			expect(findings[0]?.currentValue).toEqual(bad);
			expect(findings[0]?.description).toContain('openspec');
		});
	}

	test('control: a VALID real file yields no sdd findings and keeps the source', () => {
		writeProject({ sdd: { source: 'speckit' }, max_iterations: 7 });
		const meta = loadPluginConfigWithMeta(tempDir);
		expect(meta.config.sdd?.source).toBe('speckit');
		expect(
			runConfigDoctor(meta.config, tempDir).findings.filter(
				(f) => f.path === 'sdd' || f.path.startsWith('sdd.'),
			),
		).toEqual([]);
	});
});
