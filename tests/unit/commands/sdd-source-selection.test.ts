/**
 * `/swarm sdd status|validate|project` honoring the declarative provider
 * selection (flag > SWARM_SDD_SOURCE > sdd.source config > auto-detect).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	handleSddProjectCommand,
	handleSddStatusCommand,
	handleSddValidateCommand,
} from '../../../src/commands/sdd';
import { resetSddSelectionAdvisories } from '../../../src/sdd/effective-spec';
import { clearDeferredWarnings } from '../../../src/services/warning-buffer';
import { writeSpeckitFixture } from '../../helpers/speckit-fixture';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const OPENSPEC_SPEC =
	'## Requirements\n### Requirement: Login\nThe system MUST allow users to sign in.\n';
const MULTI = 'Multiple SDD sources detected';

let tempDir: string;
let savedEnv: string | undefined;
let savedXdg: string | undefined;

function writeFile(relPath: string, content: string): void {
	const abs = path.join(tempDir, relPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
}

function writeConfig(source: unknown): void {
	writeFile(
		path.join('.opencode', 'opencode-swarm.json'),
		JSON.stringify({ sdd: { source } }),
	);
}

function bothPresent(): void {
	writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });
	writeFile(path.join('openspec', 'specs', 'auth', 'spec.md'), OPENSPEC_SPEC);
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('sdd-cmd-select-');
	savedEnv = process.env.SWARM_SDD_SOURCE;
	savedXdg = process.env.XDG_CONFIG_HOME;
	delete process.env.SWARM_SDD_SOURCE;
	process.env.XDG_CONFIG_HOME = path.join(tempDir, '.xdg-config');
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

describe('no selection: both-present repo still hard-errors (regression guard)', () => {
	test('status errors and the message now names SWARM_SDD_SOURCE / sdd.source', async () => {
		bothPresent();
		const out = await handleSddStatusCommand(tempDir, []);
		expect(out).toContain(MULTI);
		expect(out).toContain('SWARM_SDD_SOURCE');
		expect(out).toContain('sdd.source');
		expect(out).not.toContain('## SDD Status');
	});

	test('validate errors', async () => {
		bothPresent();
		const out = await handleSddValidateCommand(tempDir, []);
		expect(out).toContain(MULTI);
		expect(out).toContain('SWARM_SDD_SOURCE');
	});

	test('project errors and writes nothing', async () => {
		bothPresent();
		const out = await handleSddProjectCommand(tempDir, []);
		expect(out).toContain(MULTI);
		expect(fs.existsSync(path.join(tempDir, '.swarm', 'spec.md'))).toBe(false);
	});

	test('unrecognized env value is ignored, so the ambiguity error still fires', async () => {
		bothPresent();
		process.env.SWARM_SDD_SOURCE = 'bogus';
		expect(await handleSddStatusCommand(tempDir, [])).toContain(MULTI);
	});
});

describe('env / config selection resolves the ambiguity', () => {
	test('status with env=openspec: no error, provider openspec, Source selection line', async () => {
		bothPresent();
		process.env.SWARM_SDD_SOURCE = 'openspec';
		const out = await handleSddStatusCommand(tempDir, []);
		expect(out).not.toContain(MULTI);
		expect(out).toContain('Provider: openspec_projection');
		expect(out).toContain('Source selection: SWARM_SDD_SOURCE=openspec');
	});

	test('status with env=speckit (padded, mixed case) resolves speckit', async () => {
		bothPresent();
		process.env.SWARM_SDD_SOURCE = ' SpecKit ';
		const out = await handleSddStatusCommand(tempDir, []);
		expect(out).not.toContain(MULTI);
		expect(out).toContain('Provider: speckit_projection');
		expect(out).toContain('Source selection: SWARM_SDD_SOURCE=speckit');
	});

	test('status with .opencode config: label names project config', async () => {
		bothPresent();
		writeConfig('openspec');
		const out = await handleSddStatusCommand(tempDir, []);
		expect(out).toContain('Provider: openspec_projection');
		expect(out).toContain(
			'Source selection: sdd.source=openspec (project config)',
		);
	});

	test('status --json adds sourceSelection {source, via} only for env/config', async () => {
		bothPresent();
		process.env.SWARM_SDD_SOURCE = 'speckit';
		const parsed = JSON.parse(
			await handleSddStatusCommand(tempDir, ['--json']),
		);
		expect(parsed.provider).toBe('speckit_projection');
		expect(parsed.sourceSelection).toEqual({
			source: 'speckit',
			via: 'SWARM_SDD_SOURCE=speckit',
		});
	});

	test('validate with env=speckit reports provider speckit_projection', async () => {
		bothPresent();
		process.env.SWARM_SDD_SOURCE = 'speckit';
		const out = await handleSddValidateCommand(tempDir, ['--json']);
		const parsed = JSON.parse(out);
		expect(parsed.provider).toBe('speckit_projection');
		expect(out).not.toContain(MULTI);
	});

	test('validate with config=openspec reports openspec_projection', async () => {
		bothPresent();
		writeConfig('openspec');
		const parsed = JSON.parse(
			await handleSddValidateCommand(tempDir, ['--json']),
		);
		expect(parsed.provider).toBe('openspec_projection');
	});

	test('project --dry-run with env=openspec previews the openspec projection and writes nothing', async () => {
		bothPresent();
		const viaFlag = await handleSddProjectCommand(tempDir, [
			'--dry-run',
			'--source',
			'openspec',
		]);
		process.env.SWARM_SDD_SOURCE = 'openspec';
		const out = await handleSddProjectCommand(tempDir, ['--dry-run']);
		expect(out).not.toContain(MULTI);
		expect(out).toContain('SDD projection preview');
		expect(out).toBe(viaFlag);
		expect(fs.existsSync(path.join(tempDir, '.swarm', 'spec.md'))).toBe(false);
	});

	test('project --dry-run with env=speckit previews the speckit projection (hash differs from openspec)', async () => {
		bothPresent();
		const openspecOut = await handleSddProjectCommand(tempDir, [
			'--dry-run',
			'--source',
			'openspec',
		]);
		const viaFlag = await handleSddProjectCommand(tempDir, [
			'--dry-run',
			'--source',
			'speckit',
		]);
		process.env.SWARM_SDD_SOURCE = 'speckit';
		const out = await handleSddProjectCommand(tempDir, ['--dry-run']);
		expect(out).not.toContain(MULTI);
		expect(out).toBe(viaFlag);
		expect(out).not.toBe(openspecOut);
		expect(fs.existsSync(path.join(tempDir, '.swarm', 'spec.md'))).toBe(false);
	});
});

describe('byte-identical default output when nothing is selected', () => {
	test('openspec-only repo: status text and --json carry no selection provenance', async () => {
		writeFile(path.join('openspec', 'specs', 'auth', 'spec.md'), OPENSPEC_SPEC);
		const text = await handleSddStatusCommand(tempDir, []);
		expect(text).toContain('Provider: openspec_projection');
		expect(text).not.toContain('Source selection');
		const json = await handleSddStatusCommand(tempDir, ['--json']);
		expect(json).not.toContain('sourceSelection');
		expect(Object.keys(JSON.parse(json))).not.toContain('sourceSelection');
	});

	test('--source flag alone (no env/config) adds no provenance either', async () => {
		bothPresent();
		const text = await handleSddStatusCommand(tempDir, ['--source', 'speckit']);
		expect(text).toContain('Provider: speckit_projection');
		expect(text).not.toContain('Source selection');
		expect(
			await handleSddStatusCommand(tempDir, ['--source', 'speckit', '--json']),
		).not.toContain('sourceSelection');
	});
});

describe('--source flag overrides env and config', () => {
	test('env=speckit + --source openspec yields openspec and no Source selection line', async () => {
		bothPresent();
		process.env.SWARM_SDD_SOURCE = 'speckit';
		const out = await handleSddStatusCommand(tempDir, ['--source', 'openspec']);
		expect(out).toContain('Provider: openspec_projection');
		expect(out).not.toContain('Source selection');
		const json = await handleSddStatusCommand(tempDir, [
			'--source',
			'openspec',
			'--json',
		]);
		expect(json).not.toContain('sourceSelection');
	});

	test('config=speckit + --source openspec on validate yields openspec', async () => {
		bothPresent();
		writeConfig('speckit');
		const parsed = JSON.parse(
			await handleSddValidateCommand(tempDir, [
				'--source',
				'openspec',
				'--json',
			]),
		);
		expect(parsed.provider).toBe('openspec_projection');
	});

	test('a bogus env value is irrelevant when --source is given', async () => {
		bothPresent();
		process.env.SWARM_SDD_SOURCE = 'bogus';
		const out = await handleSddStatusCommand(tempDir, ['--source', 'openspec']);
		expect(out).toContain('Provider: openspec_projection');
	});
});

describe('error paths that name the selected source', () => {
	test('project with env=swarm errors with SDD source "swarm" (selected via …)', async () => {
		bothPresent();
		process.env.SWARM_SDD_SOURCE = 'swarm';
		const out = await handleSddProjectCommand(tempDir, ['--dry-run']);
		expect(out).toContain(
			'SDD source "swarm" (selected via SWARM_SDD_SOURCE=swarm)',
		);
		expect(out).not.toContain('SDD projection');
	});

	test('project with config=swarm names the config label', async () => {
		bothPresent();
		writeConfig('swarm');
		const out = await handleSddProjectCommand(tempDir, ['--dry-run']);
		expect(out).toContain('selected via sdd.source=swarm (project config)');
	});

	test('project --source swarm keeps the original flag wording', async () => {
		bothPresent();
		const out = await handleSddProjectCommand(tempDir, ['--source', 'swarm']);
		expect(out).toContain('--source swarm selects the native');
		expect(out).not.toContain('selected via');
	});

	for (const [name, run] of [
		['status', (a: string[]) => handleSddStatusCommand(tempDir, a)],
		['validate', (a: string[]) => handleSddValidateCommand(tempDir, a)],
		['project', (a: string[]) => handleSddProjectCommand(tempDir, a)],
	] as const) {
		test(`${name} --feature with env=openspec errors mentioning the selected source`, async () => {
			bothPresent();
			process.env.SWARM_SDD_SOURCE = 'openspec';
			const out = await run(['--feature', '001-auth-service']);
			expect(out).toContain('--feature is only valid with --source speckit');
			expect(out).toContain('the selected source is SWARM_SDD_SOURCE=openspec');
		});
	}

	test('--feature with explicit --source openspec keeps the plain error (no selection suffix)', async () => {
		bothPresent();
		process.env.SWARM_SDD_SOURCE = 'speckit';
		const out = await handleSddStatusCommand(tempDir, [
			'--source',
			'openspec',
			'--feature',
			'001-auth-service',
		]);
		expect(out).toContain('--feature is only valid with --source speckit');
		expect(out).not.toContain('the selected source is');
	});

	test('--feature with env=speckit is accepted (no feature/source error)', async () => {
		bothPresent();
		process.env.SWARM_SDD_SOURCE = 'speckit';
		const out = await handleSddStatusCommand(tempDir, [
			'--feature',
			'001-auth-service',
		]);
		expect(out).not.toContain('--feature is only valid');
	});
});
