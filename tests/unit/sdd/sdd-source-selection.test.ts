/**
 * Declarative SDD provider selection (SWARM_SDD_SOURCE env + `sdd.source` config)
 * as resolved by readEffectiveSpecSync / resolveSddSourceSelection.
 *
 * Each test names the regression it guards. Process-wide state (the env var and
 * XDG_CONFIG_HOME) is pinned per test and restored exactly afterwards.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	readEffectiveSpecSync,
	resetSddSelectionAdvisories,
	resolveSddSourceSelection,
} from '../../../src/sdd/effective-spec';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { writeSpeckitFixture } from '../../helpers/speckit-fixture';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const OPENSPEC_SPEC =
	'## Requirements\n### Requirement: Login\nThe system MUST allow users to sign in.\n';

let tempDir: string;
let xdgDir: string;
let savedEnv: string | undefined;
let savedXdg: string | undefined;

function writeFile(relPath: string, content: string): void {
	const abs = path.join(tempDir, relPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
}

function writeProjectConfig(content: string): string {
	const rel = path.join('.opencode', 'opencode-swarm.json');
	writeFile(rel, content);
	return path.join(tempDir, rel);
}

function writeUserConfig(content: string): void {
	const abs = path.join(xdgDir, 'opencode', 'opencode-swarm.json');
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
}

function addOpenspec(): void {
	writeFile(path.join('openspec', 'specs', 'auth', 'spec.md'), OPENSPEC_SPEC);
}

function addSpeckit(
	variant: 'single-explicit-fr' | 'multi-feature' = 'single-explicit-fr',
): void {
	writeSpeckitFixture(tempDir, { variant });
}

function bothPresent(): void {
	addSpeckit();
	addOpenspec();
}

function warnings(): string[] {
	return [...getDeferredWarnings()];
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('sdd-selection-');
	xdgDir = path.join(tempDir, '.xdg-config');
	savedEnv = process.env.SWARM_SDD_SOURCE;
	savedXdg = process.env.XDG_CONFIG_HOME;
	delete process.env.SWARM_SDD_SOURCE;
	process.env.XDG_CONFIG_HOME = xdgDir;
	resetSddSelectionAdvisories();
	clearDeferredWarnings();
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env.SWARM_SDD_SOURCE;
	else process.env.SWARM_SDD_SOURCE = savedEnv;
	if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = savedXdg;
	resetSddSelectionAdvisories();
	clearDeferredWarnings();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('env selection', () => {
	test('env=openspec on a both-present repo resolves openspec (regression: ambiguity null)', () => {
		bothPresent();
		process.env.SWARM_SDD_SOURCE = 'openspec';
		const result = readEffectiveSpecSync(tempDir);
		expect(result?.source).toBe('openspec_projection');
		expect(result?.content).toContain('sign in');
		expect(warnings()).toEqual([]);
	});

	test('env=speckit on a both-present repo resolves speckit and not openspec content', () => {
		bothPresent();
		process.env.SWARM_SDD_SOURCE = 'speckit';
		const result = readEffectiveSpecSync(tempDir);
		expect(result?.source).toBe('speckit_projection');
		expect(result?.content).toContain('authenticate users');
		expect(result?.content).not.toContain('sign in');
		expect(warnings()).toEqual([]);
	});

	test('env is case-insensitive and whitespace-trimmed (" SpecKit ")', () => {
		bothPresent();
		process.env.SWARM_SDD_SOURCE = '  SpecKit \t';
		const sel = resolveSddSourceSelection(tempDir);
		expect(sel).toEqual({
			source: 'speckit',
			origin: 'env',
			label: 'SWARM_SDD_SOURCE=speckit',
		});
		expect(readEffectiveSpecSync(tempDir)?.source).toBe('speckit_projection');
		expect(warnings()).toEqual([]);
	});

	test('empty and whitespace-only env are treated as unset (falls to auto-detect, no advisory)', () => {
		addOpenspec();
		process.env.SWARM_SDD_SOURCE = '';
		expect(resolveSddSourceSelection(tempDir)).toBeUndefined();
		process.env.SWARM_SDD_SOURCE = '   ';
		expect(resolveSddSourceSelection(tempDir)).toBeUndefined();
		expect(readEffectiveSpecSync(tempDir)?.source).toBe('openspec_projection');
		expect(warnings()).toEqual([]);
	});

	test('env=speckit honors opts.feature on a multi-feature repo (regression: feature dropped on selected path)', () => {
		addSpeckit('multi-feature');
		process.env.SWARM_SDD_SOURCE = 'speckit';
		const alpha = readEffectiveSpecSync(tempDir, { feature: '001-alpha' });
		expect(alpha?.source).toBe('speckit_projection');
		expect(alpha?.content).toContain('alpha capability');
		expect(alpha?.content).not.toContain('beta capability');
		const beta = readEffectiveSpecSync(tempDir, { feature: '002-beta' });
		expect(beta?.content).toContain('beta capability');
		expect(beta?.content).not.toContain('alpha capability');
	});
});

describe('config selection', () => {
	test('project .opencode config selects the provider on a both-present repo', () => {
		bothPresent();
		writeProjectConfig(JSON.stringify({ sdd: { source: 'openspec' } }));
		const sel = resolveSddSourceSelection(tempDir);
		expect(sel?.origin).toBe('project-config');
		expect(sel?.label).toBe('sdd.source=openspec (project config)');
		expect(readEffectiveSpecSync(tempDir)?.source).toBe('openspec_projection');
		expect(warnings()).toEqual([]);
	});

	test('REPO-ROOT opencode-swarm.json is NOT honored (corrected location): both-present stays ambiguous', () => {
		bothPresent();
		writeFile(
			'opencode-swarm.json',
			JSON.stringify({ sdd: { source: 'openspec' } }),
		);
		expect(resolveSddSourceSelection(tempDir)).toBeUndefined();
		expect(readEffectiveSpecSync(tempDir)).toBeNull();
		const w = warnings();
		expect(w).toHaveLength(1);
		expect(w[0]).toContain('Multiple SDD sources detected');
		expect(w[0]).toContain('SWARM_SDD_SOURCE');
	});

	test('user-level config (XDG_CONFIG_HOME) is honored and labelled user config', () => {
		bothPresent();
		writeUserConfig(JSON.stringify({ sdd: { source: 'speckit' } }));
		const sel = resolveSddSourceSelection(tempDir);
		expect(sel?.origin).toBe('user-config');
		expect(sel?.label).toBe('sdd.source=speckit (user config)');
		expect(readEffectiveSpecSync(tempDir)?.source).toBe('speckit_projection');
	});

	test('project config overrides user config', () => {
		bothPresent();
		writeUserConfig(JSON.stringify({ sdd: { source: 'speckit' } }));
		writeProjectConfig(JSON.stringify({ sdd: { source: 'openspec' } }));
		expect(resolveSddSourceSelection(tempDir)?.source).toBe('openspec');
		expect(readEffectiveSpecSync(tempDir)?.source).toBe('openspec_projection');
	});

	test('env beats config (env=openspec, config=speckit)', () => {
		bothPresent();
		writeProjectConfig(JSON.stringify({ sdd: { source: 'speckit' } }));
		process.env.SWARM_SDD_SOURCE = 'openspec';
		expect(resolveSddSourceSelection(tempDir)?.origin).toBe('env');
		expect(readEffectiveSpecSync(tempDir)?.source).toBe('openspec_projection');
	});

	test('BOM-prefixed valid config is honored', () => {
		bothPresent();
		writeProjectConfig(`﻿${JSON.stringify({ sdd: { source: 'openspec' } })}`);
		expect(resolveSddSourceSelection(tempDir)?.source).toBe('openspec');
	});

	test('malformed JSON config: no throw, falls to auto-detect', () => {
		addOpenspec();
		writeProjectConfig('{ "sdd": { "source": "speckit" ');
		expect(() => readEffectiveSpecSync(tempDir)).not.toThrow();
		expect(readEffectiveSpecSync(tempDir)?.source).toBe('openspec_projection');
	});

	test('config over the 100KB cap is ignored without throwing', () => {
		addOpenspec();
		writeProjectConfig(
			JSON.stringify({
				sdd: { source: 'speckit' },
				pad: 'x'.repeat(110 * 1024),
			}),
		);
		expect(() => resolveSddSourceSelection(tempDir)).not.toThrow();
		expect(resolveSddSourceSelection(tempDir)).toBeUndefined();
		// speckit selection was NOT applied: openspec-only repo still resolves
		expect(readEffectiveSpecSync(tempDir)?.source).toBe('openspec_projection');
	});
});

describe('opts.source and native spec precedence', () => {
	test('opts.source beats env and config and performs no env lookup (no "Ignoring" advisory for bogus env)', () => {
		bothPresent();
		process.env.SWARM_SDD_SOURCE = 'bogus';
		writeProjectConfig(JSON.stringify({ sdd: { source: 'speckit' } }));
		const result = readEffectiveSpecSync(tempDir, { source: 'openspec' });
		expect(result?.source).toBe('openspec_projection');
		expect(warnings().filter((m) => m.includes('Ignoring'))).toEqual([]);
		expect(warnings()).toEqual([]);
	});

	test('opts.source selection yielding null buffers NO "selected via" advisory (only env/config do)', () => {
		addSpeckit();
		expect(readEffectiveSpecSync(tempDir, { source: 'openspec' })).toBeNull();
		expect(warnings()).toEqual([]);
	});

	test('native .swarm/spec.md wins over env and config selection', () => {
		bothPresent();
		writeFile(
			path.join('.swarm', 'spec.md'),
			'# Native\n\nFR-001: native requirement MUST hold.\n',
		);
		writeProjectConfig(JSON.stringify({ sdd: { source: 'speckit' } }));
		process.env.SWARM_SDD_SOURCE = 'openspec';
		const result = readEffectiveSpecSync(tempDir);
		expect(result?.source).toBe('swarm');
		expect(result?.content).toContain('native requirement');
		expect(warnings()).toEqual([]);
	});
});

describe('invalid values are never silent', () => {
	test('unrecognized env: exactly one "Ignoring SWARM_SDD_SOURCE" advisory, resolution continues to config', () => {
		bothPresent();
		process.env.SWARM_SDD_SOURCE = 'bogus';
		writeProjectConfig(JSON.stringify({ sdd: { source: 'openspec' } }));
		const result = readEffectiveSpecSync(tempDir);
		expect(result?.source).toBe('openspec_projection');
		const w = warnings();
		expect(w).toHaveLength(1);
		expect(w[0]).toContain('Ignoring SWARM_SDD_SOURCE');
		expect(w[0]).toContain('"bogus"');
	});

	test('unrecognized env with no config falls to auto-detect (ambiguity null + both advisories)', () => {
		bothPresent();
		process.env.SWARM_SDD_SOURCE = 'bogus';
		expect(readEffectiveSpecSync(tempDir)).toBeNull();
		const w = warnings();
		expect(
			w.filter((m) => m.includes('Ignoring SWARM_SDD_SOURCE')),
		).toHaveLength(1);
		expect(w.filter((m) => m.includes('Multiple SDD sources'))).toHaveLength(1);
	});

	test('advisory is de-duplicated across calls; resetSddSelectionAdvisories re-arms it', () => {
		addOpenspec();
		process.env.SWARM_SDD_SOURCE = 'bogus';
		readEffectiveSpecSync(tempDir);
		readEffectiveSpecSync(tempDir);
		readEffectiveSpecSync(tempDir);
		expect(
			warnings().filter((m) => m.includes('Ignoring SWARM_SDD_SOURCE')),
		).toHaveLength(1);
		clearDeferredWarnings();
		readEffectiveSpecSync(tempDir);
		expect(warnings()).toEqual([]); // still deduped even after buffer clear
		resetSddSelectionAdvisories();
		readEffectiveSpecSync(tempDir);
		expect(
			warnings().filter((m) => m.includes('Ignoring SWARM_SDD_SOURCE')),
		).toHaveLength(1);
	});

	test('very long bogus env value is truncated in the advisory', () => {
		process.env.SWARM_SDD_SOURCE = 'z'.repeat(500);
		resolveSddSourceSelection(tempDir);
		const w = warnings();
		expect(w).toHaveLength(1);
		expect(w[0]?.length).toBeLessThan(400);
		expect(w[0]).toContain('…');
	});

	for (const [name, value] of [
		['wrong-case string', 'Speckit'],
		['number', 42],
		['object', {}],
		['array', ['x']],
	] as const) {
		test(`invalid config source (${name}): one "Ignoring sdd.source" advisory naming the config path, falls to auto-detect`, () => {
			addOpenspec();
			const cfgPath = writeProjectConfig(
				JSON.stringify({ sdd: { source: value } }),
			);
			expect(resolveSddSourceSelection(tempDir)).toBeUndefined();
			const result = readEffectiveSpecSync(tempDir);
			expect(result?.source).toBe('openspec_projection');
			const w = warnings().filter((m) => m.includes('Ignoring sdd.source'));
			expect(w).toHaveLength(1);
			expect(w[0]).toContain(cfgPath);
		});
	}

	test('non-object sdd value is handled without throwing, falls to auto-detect, and names the bad FIELD (sdd, not sdd.source)', () => {
		addOpenspec();
		writeProjectConfig(JSON.stringify({ sdd: 'openspec' }));
		expect(() => readEffectiveSpecSync(tempDir)).not.toThrow();
		expect(readEffectiveSpecSync(tempDir)?.source).toBe('openspec_projection');
		const w = warnings().filter((m) => m.includes('Ignoring sdd='));
		expect(w).toHaveLength(1);
		expect(w[0]).toContain('expected an object');
		expect(warnings().filter((m) => m.includes('Ignoring sdd.source'))).toEqual(
			[],
		);
	});

	test('invalid project value does not mask a valid user-level value', () => {
		bothPresent();
		writeProjectConfig(JSON.stringify({ sdd: { source: 'Speckit' } }));
		writeUserConfig(JSON.stringify({ sdd: { source: 'openspec' } }));
		expect(resolveSddSourceSelection(tempDir)?.source).toBe('openspec');
		expect(
			warnings().filter((m) => m.includes('Ignoring sdd.source')),
		).toHaveLength(1);
	});
});

describe('explicit selection is final (no fall-through)', () => {
	test('env=openspec on a speckit-only repo returns null with a "selected via SWARM_SDD_SOURCE=openspec" advisory', () => {
		addSpeckit();
		process.env.SWARM_SDD_SOURCE = 'openspec';
		expect(readEffectiveSpecSync(tempDir)).toBeNull();
		const w = warnings();
		expect(w).toHaveLength(1);
		expect(w[0]).toContain('selected via SWARM_SDD_SOURCE=openspec');
		// De-duplicated on repeat.
		readEffectiveSpecSync(tempDir);
		expect(warnings()).toHaveLength(1);
	});

	test('env=swarm without .swarm/spec.md returns null and mentions the missing native spec', () => {
		bothPresent();
		process.env.SWARM_SDD_SOURCE = 'swarm';
		expect(readEffectiveSpecSync(tempDir)).toBeNull();
		const w = warnings();
		expect(w).toHaveLength(1);
		expect(w[0]).toContain('no usable native .swarm/spec.md');
	});

	test('env=swarm with an OVERSIZE native .swarm/spec.md: advisory does not claim the file is missing', () => {
		addOpenspec();
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		// MAX_SPEC_BYTES is 256 KiB: the native branch skips this file, so the
		// swarm selection resolves to null even though the file exists.
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'spec.md'),
			'x'.repeat(300 * 1024),
		);
		process.env.SWARM_SDD_SOURCE = 'swarm';
		expect(readEffectiveSpecSync(tempDir)).toBeNull();
		const w = warnings();
		expect(w).toHaveLength(1);
		expect(w[0]).toContain('over the size limit');
		expect(w[0]).not.toContain('no native .swarm/spec.md exists');
	});

	test('config-selected null yields an advisory labelled "sdd.source=… (project config)"', () => {
		addOpenspec();
		writeProjectConfig(JSON.stringify({ sdd: { source: 'speckit' } }));
		expect(readEffectiveSpecSync(tempDir)).toBeNull();
		const w = warnings();
		expect(w).toHaveLength(1);
		expect(w[0]).toContain('sdd.source=speckit (project config)');
		expect(w[0]).toContain('selected via');
	});

	test('a selected provider that resolves buffers no advisory at all', () => {
		addOpenspec();
		process.env.SWARM_SDD_SOURCE = 'openspec';
		expect(readEffectiveSpecSync(tempDir)).not.toBeNull();
		expect(warnings()).toEqual([]);
	});
});
