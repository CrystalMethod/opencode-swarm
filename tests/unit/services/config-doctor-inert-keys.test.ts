import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PluginConfigSchema } from '../../../src/config/schema';
import {
	collectRawInertKeyFindings,
	runConfigDoctor,
} from '../../../src/services/config-doctor';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Issue #2957: pin BOTH arms of the inert-config-key advisory. Since #3065
// wired ctx.config into the harness-opt/skill-opt closures (issue #2949),
// harness_opt and skill_opt are consumed plugin-config keys — the production
// map must keep doctor silent on them (the "passes clean post-J6" end-state).
// The DI parameter on collectRawInertKeyFindings proves the opposite (inert)
// arm on any tree without mock.module, per the issue's "DI tests pin both
// arms so merge order cannot break either PR" contract.

// Isolate the raw collectors from this machine's real user config (they read
// ~/.config/opencode/opencode-swarm.json when XDG_CONFIG_HOME is unset — the
// #2102 raw-collector contract, same pattern as config-doctor-inert-key-2904).
const PREV_XDG = process.env.XDG_CONFIG_HOME;
// The .config segment must live inside the temp root (getConfigPaths asserts
// the .config substring — the C10 precedent). canonicalMkdtemp satisfies FR-011.
const XDG_BASE = canonicalMkdtemp('2957-inert-keys-xdg-');
const XDG_ROOT = path.join(XDG_BASE, '.config');
fs.mkdirSync(XDG_ROOT, { recursive: true });

beforeEach(() => {
	process.env.XDG_CONFIG_HOME = XDG_ROOT;
});

afterAll(() => {
	if (PREV_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = PREV_XDG;
	fs.rmSync(XDG_BASE, { recursive: true, force: true });
});

function tempProject(): string {
	return canonicalMkdtemp('2957-inert-keys-proj-');
}

function writeProjectConfig(dir: string, raw: Record<string, unknown>): void {
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(raw),
		'utf8',
	);
}

function defaults() {
	return PluginConfigSchema.parse({});
}

describe('config doctor — inert-config-key arms (issue #2957)', () => {
	it('production map: setting harness_opt and skill_opt stays silent (consumed post-#3065)', () => {
		const dir = tempProject();
		try {
			writeProjectConfig(dir, {
				harness_opt: { enabled: true },
				skill_opt: { enabled: true },
			});
			const result = runConfigDoctor(defaults(), dir);
			const hits = result.findings.filter(
				(f) =>
					f.id === 'inert-config-key' &&
					(f.path === 'harness_opt' || f.path === 'skill_opt'),
			);
			expect(hits).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('production map: the parallelization control still warns (mechanism alive)', () => {
		const dir = tempProject();
		try {
			writeProjectConfig(dir, { parallelization: { enabled: true } });
			const result = runConfigDoctor(defaults(), dir);
			const finding = result.findings.find(
				(f) => f.id === 'inert-config-key' && f.path === 'parallelization',
			);
			expect(finding).toBeDefined();
			expect(finding?.severity).toBe('warn');
			expect(result.summary.warn).toBeGreaterThanOrEqual(1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('DI inert arm: injected inert declarations warn by name with the full reason rendered', () => {
		const dir = tempProject();
		try {
			writeProjectConfig(dir, {
				harness_opt: { enabled: true },
				skill_opt: { enabled: true },
			});
			const harnessReason =
				'no runtime consumer: handlers read opencode.json instead (pre-#3065 shape); replacement: none until wiring lands';
			const skillReason =
				'no runtime consumer: plan or run reads opencode.json instead (pre-#3065 shape); replacement: none until wiring lands';
			const findings = collectRawInertKeyFindings(dir, {
				harness_opt: { inert: harnessReason },
				skill_opt: { inert: skillReason },
			});
			expect(findings).toHaveLength(2);
			for (const key of ['harness_opt', 'skill_opt'] as const) {
				const finding = findings.find((f) => f.path === key);
				expect(finding).toBeDefined();
				expect(finding?.id).toBe('inert-config-key');
				expect(finding?.severity).toBe('warn');
				expect(finding?.autoFixable).toBe(false);
				const reason = key === 'harness_opt' ? harnessReason : skillReason;
				expect(finding?.description).toContain(key);
				expect(finding?.description).toContain(reason);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('DI consumed arm: injected consumers declarations stay silent', () => {
		const dir = tempProject();
		try {
			writeProjectConfig(dir, {
				harness_opt: { enabled: true },
				skill_opt: { enabled: true },
			});
			const findings = collectRawInertKeyFindings(dir, {
				harness_opt: {
					consumers: ['src/commands/harness-opt.ts:handleHarnessOptRun'],
				},
				skill_opt: {
					consumers: ['src/commands/skill-opt.ts:handleSkillOptPlan'],
				},
			});
			expect(findings).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('key-absent arm: only keys the user actually set are flagged', () => {
		const dir = tempProject();
		try {
			writeProjectConfig(dir, { todo_gate: { mode: 'advisory' } });
			const findings = collectRawInertKeyFindings(dir, {
				harness_opt: {
					inert: 'no runtime consumer (injected test declaration)',
				},
			});
			expect(findings).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
