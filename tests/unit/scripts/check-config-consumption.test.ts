import { describe, expect, it } from 'bun:test';
import {
	bracketAccessMatches,
	canonicalizeCitationPath,
	citationAllowed,
	collectFindings,
	DOCTOR_FILE,
	keyReferenced,
	SEAM_SYMBOLS,
	type SourceTree,
	scanSource,
	symbolDeclared,
} from '../../../scripts/check-config-consumption';

function makeTree(files: Record<string, string>): SourceTree {
	const set = new Set(Object.keys(files));
	return {
		files: set,
		readFile: (p) => files[p] ?? null,
	};
}

describe('check-config-consumption — citation paths', () => {
	it('allows non-test src files', () => {
		expect(citationAllowed('src/hooks/pipeline-tracker.ts')).toBe(true);
	});
	it('rejects tests, schema.ts, non-src, and root escapes', () => {
		expect(citationAllowed('tests/unit/x.test.ts')).toBe(false);
		expect(citationAllowed('src/unit/x.test.ts')).toBe(false);
		expect(citationAllowed('src/config/schema.ts')).toBe(false);
		expect(citationAllowed('lib/config.ts')).toBe(false);
		expect(citationAllowed('../etc/passwd')).toBe(false);
	});
	it('canonicalizes path aliases before the path rules', () => {
		// dotdot alias of the doctor file canonicalizes to the doctor file
		expect(
			canonicalizeCitationPath('src/../src/services/config-doctor.ts'),
		).toBe(DOCTOR_FILE);
		// doubled-dot alias of schema.ts is still banned
		expect(citationAllowed('src/config/././schema.ts')).toBe(false);
		expect(citationAllowed('src/../src/config/schema.ts')).toBe(false);
		// src-prefixed root escape rejects (v5 allowed this form)
		expect(citationAllowed('src/config/../../../etc/passwd')).toBe(false);
	});
	it('case-folds the path rules for case-insensitive filesystems', () => {
		expect(citationAllowed('src/Config/Schema.ts')).toBe(false);
	});
});

describe('check-config-consumption — matching model', () => {
	it('member access with identifier boundary validates; prefix siblings do not', () => {
		const src =
			'function f(cfg: any) {\n\treturn cfg.turbo_mode === true;\n}\n';
		const noKeep = scanSource(src, '');
		const keep = scanSource(src, 'turbo_mode');
		expect(keyReferenced('turbo_mode', noKeep, keep)).toBe(true);
		const src2 = 'function f(cfg: any) {\n\treturn cfg.turbo_mode;\n}\n';
		expect(
			keyReferenced('turbo', scanSource(src2, ''), scanSource(src2, 'turbo')),
		).toBe(false);
	});
	it('comment-only and string-literal mentions do not validate', () => {
		const comment =
			'// reads .future_dead when enabled\nexport const anchor = 1;\n';
		expect(
			keyReferenced(
				'future_dead',
				scanSource(comment, ''),
				scanSource(comment, 'future_dead'),
			),
		).toBe(false);
		const strLit =
			'export const HELP = "cfg[\'future_dead\'] toggles it";\nexport const a = 1;\n';
		expect(
			keyReferenced(
				'future_dead',
				scanSource(strLit, ''),
				scanSource(strLit, 'future_dead'),
			),
		).toBe(false);
		const caseInString =
			"export const HELP = 'handles the case \\'future_dead\\' when set';\nexport const a = 1;\n";
		expect(
			keyReferenced(
				'future_dead',
				scanSource(caseInString, ''),
				scanSource(caseInString, 'future_dead'),
			),
		).toBe(false);
	});
	it('array literals in keyword-adjacent contexts do not validate', () => {
		const cases = [
			"export function deadKeys(): string[] {\n\treturn ['future_dead'];\n}\n",
			"export const agents = ['future_dead'];\nexport const a = 1;\n",
			"export const meta = {\n\tagents: ['future_dead'],\n};\n",
			"export const x = 1;\nexport function f(c: boolean) {\n\tif (c) ['future_dead'];\n}\n",
			"export function* gen() {\n\tyield ['future_dead'];\n}\n",
		];
		for (const src of cases) {
			expect(
				keyReferenced(
					'future_dead',
					scanSource(src, ''),
					scanSource(src, 'future_dead'),
				),
			).toBe(false);
		}
	});
	it('mycase ASI juxtaposition does not validate (word-boundary case)', () => {
		const src = "export const mycase\n'future_dead'\n";
		expect(
			keyReferenced(
				'future_dead',
				scanSource(src, ''),
				scanSource(src, 'future_dead'),
			),
		).toBe(false);
	});
	it('real bracket access, case labels, and interpolation reads validate', () => {
		const bracket =
			"export function readCfg(cfg: Record<string, unknown>) {\n\treturn cfg['future_dead'] === true;\n}\n";
		expect(
			keyReferenced(
				'future_dead',
				scanSource(bracket, ''),
				scanSource(bracket, 'future_dead'),
			),
		).toBe(true);
		const chained =
			"export function r(rows: Array<Record<string, unknown>>) {\n\treturn rows[0]['future_dead'] === true;\n}\n";
		expect(
			bracketAccessMatches(
				scanSource(chained, 'future_dead').masked,
				'future_dead',
			),
		).toBe(true);
		const caseLabel =
			"export function pick(k: string) {\n\tswitch (k) {\n\t\tcase 'future_dead':\n\t\t\treturn 1;\n\t\tdefault:\n\t\t\treturn 0;\n\t}\n}\n";
		expect(
			keyReferenced(
				'future_dead',
				scanSource(caseLabel, ''),
				scanSource(caseLabel, 'future_dead'),
			),
		).toBe(true);
		const interp =
			"export const label = `${cfg['future_dead']}`;\nexport const a = 1;\n";
		expect(
			keyReferenced(
				'future_dead',
				scanSource(interp, ''),
				scanSource(interp, 'future_dead'),
			),
		).toBe(true);
	});
	it('KNOWN ACCEPTED IMPRECISION: object-literal label maps match the destructure pattern', () => {
		// { future_dead: 'label' } is textually indistinguishable from a destructure
		// rename; this class is accepted and documented (issue #2904 plan, round-7 R7-3).
		const src = "export const KEY_LABELS = { future_dead: 'Future Dead' };\n";
		expect(
			keyReferenced(
				'future_dead',
				scanSource(src, ''),
				scanSource(src, 'future_dead'),
			),
		).toBe(true);
	});
	it('symbol declarations are found in comment-stripped source', () => {
		const src =
			'// export function fake() {}\nexport function realReader(): boolean {\n\treturn true;\n}\n';
		expect(symbolDeclared('realReader', scanSource(src, ''))).toBe(true);
		expect(symbolDeclared('fake', scanSource(src, ''))).toBe(false);
	});
	it('SEAM_SYMBOLS contains the DI/test seams', () => {
		expect(SEAM_SYMBOLS.has('_internals')).toBe(true);
		expect(SEAM_SYMBOLS.has('_test_exports')).toBe(true);
	});
});

describe('check-config-consumption — collectFindings fixtures', () => {
	const SCHEMA_KEYS = ['alpha', 'beta', 'gamma'];
	const READER =
		'export function readAlpha(config: { alpha?: { enabled?: boolean } }): boolean {\n\treturn config.alpha?.enabled === true;\n}\n';
	const GAMMA_READER =
		'export function readGamma(config: { gamma?: boolean }): boolean {\n\treturn config.gamma === true;\n}\n';
	const DOCTOR_SRC = `export function validateConfigKey(path: string): number {\n\tswitch (path) {\n\t\tcase 'alpha':\n\t\tcase 'beta':\n\t\tcase 'gamma':\n\t\t\treturn 1;\n\t\tdefault:\n\t\t\treturn 0;\n\t}\n}\n`;

	function treeFor(extra: Record<string, string> = {}): SourceTree {
		return makeTree({
			'src/alpha-reader.ts': READER,
			'src/gamma-reader.ts': GAMMA_READER,
			[DOCTOR_FILE]: DOCTOR_SRC,
			...extra,
		});
	}

	it('accepts a self-consistent declaration set (positive fixture)', () => {
		const findings = collectFindings({
			schemaKeys: SCHEMA_KEYS,
			declarations: {
				alpha: { consumers: ['src/alpha-reader.ts:readAlpha'] },
				beta: { inert: 'fixture inert by design' },
				gamma: { consumers: ['src/gamma-reader.ts:readGamma'] },
			},
			tree: treeFor(),
		});
		expect(findings).toEqual([]);
	});

	it('fails an undeclared schema key', () => {
		const findings = collectFindings({
			schemaKeys: [...SCHEMA_KEYS, 'delta'],
			declarations: {
				alpha: { consumers: ['src/alpha-reader.ts:readAlpha'] },
				beta: { inert: 'x' },
				gamma: { consumers: ['src/alpha-reader.ts:readAlpha'] },
			},
			tree: treeFor(),
		});
		expect(
			findings.some((f) => f.kind === 'undeclared-key' && f.key === 'delta'),
		).toBe(true);
	});

	it('fails a stale citation (file no longer references the key)', () => {
		const stale = 'export function readAlpha(): boolean {\n\treturn true;\n}\n';
		const findings = collectFindings({
			schemaKeys: SCHEMA_KEYS,
			declarations: {
				alpha: { consumers: ['src/alpha-reader.ts:readAlpha'] },
				beta: { inert: 'x' },
				gamma: { consumers: ['src/other.ts:readAlpha'] },
			},
			tree: makeTree({
				'src/alpha-reader.ts': READER,
				'src/other.ts': stale,
				[DOCTOR_FILE]: DOCTOR_SRC,
			}),
		});
		const staleFinding = findings.find(
			(f) => f.kind === 'stale-citation' && f.key === 'gamma',
		);
		expect(staleFinding).toBeDefined();
		expect(staleFinding?.detail).toContain('stale');
	});

	it('fails a missing cited file and a missing symbol', () => {
		const findings = collectFindings({
			schemaKeys: SCHEMA_KEYS,
			declarations: {
				alpha: { consumers: ['src/alpha-reader.ts:readAlpha'] },
				beta: { inert: 'x' },
				gamma: { consumers: ['src/__missing__.ts:readAlpha'] },
			},
			tree: treeFor(),
		});
		expect(
			findings.some((f) => f.kind === 'missing-file' && f.key === 'gamma'),
		).toBe(true);
		const findings2 = collectFindings({
			schemaKeys: SCHEMA_KEYS,
			declarations: {
				alpha: { consumers: ['src/alpha-reader.ts:notASymbol'] },
				beta: { inert: 'x' },
				gamma: { consumers: ['src/alpha-reader.ts:readAlpha'] },
			},
			tree: treeFor(),
		});
		expect(
			findings2.some((f) => f.kind === 'symbol-missing' && f.key === 'alpha'),
		).toBe(true);
	});

	it('fails empty consumers, empty inert reason, and dual shapes', () => {
		const findings = collectFindings({
			schemaKeys: SCHEMA_KEYS,
			declarations: {
				alpha: { consumers: [] },
				beta: { inert: '   ' },
				gamma: { consumers: ['src/alpha-reader.ts:readAlpha'], inert: 'both' },
			},
			tree: treeFor(),
		});
		expect(
			findings.some((f) => f.kind === 'empty-consumers' && f.key === 'alpha'),
		).toBe(true);
		expect(
			findings.some((f) => f.kind === 'empty-inert-reason' && f.key === 'beta'),
		).toBe(true);
		expect(
			findings.some((f) => f.kind === 'dual-shape' && f.key === 'gamma'),
		).toBe(true);
	});

	it('fails citations to tests/**, schema.ts, and seam symbols', () => {
		const tests = collectFindings({
			schemaKeys: SCHEMA_KEYS,
			declarations: {
				alpha: { consumers: ['tests/unit/x.test.ts:readAlpha'] },
				beta: { inert: 'x' },
				gamma: { consumers: ['src/alpha-reader.ts:readAlpha'] },
			},
			tree: treeFor(),
		});
		expect(
			tests.some((f) => f.kind === 'path-not-allowed' && f.key === 'alpha'),
		).toBe(true);
		const schemaCite = collectFindings({
			schemaKeys: SCHEMA_KEYS,
			declarations: {
				alpha: { consumers: ['src/config/schema.ts:PluginConfigSchema'] },
				beta: { inert: 'x' },
				gamma: { consumers: ['src/alpha-reader.ts:readAlpha'] },
			},
			tree: treeFor({
				'src/config/schema.ts': 'export const PluginConfigSchema = {};\n',
			}),
		});
		expect(
			schemaCite.some(
				(f) => f.kind === 'path-not-allowed' && f.key === 'alpha',
			),
		).toBe(true);
		const seam = collectFindings({
			schemaKeys: SCHEMA_KEYS,
			declarations: {
				alpha: { consumers: ['src/alpha-reader.ts:_internals'] },
				beta: { inert: 'x' },
				gamma: { consumers: ['src/alpha-reader.ts:readAlpha'] },
			},
			tree: treeFor(),
		});
		expect(
			seam.some((f) => f.kind === 'seam-symbol' && f.key === 'alpha'),
		).toBe(true);
	});

	it('fails doctor-file-only citations for ANY doctor symbol (non-exempt keys)', () => {
		for (const symbol of [
			'validateConfigKey',
			'runConfigDoctor',
			'CONFIG_DOCTOR_MAX_CONFIG_FILE_BYTES',
		]) {
			const declarations: Record<
				string,
				{ consumers: string[] } | { inert: string }
			> = {
				alpha: { consumers: [`${DOCTOR_FILE}:${symbol}`] },
				beta: { inert: 'x' },
				gamma: { consumers: ['src/alpha-reader.ts:readAlpha'] },
			};
			const doctorSrc =
				DOCTOR_SRC +
				`export function runConfigDoctor(): number {\n\treturn 1;\n}\nexport const CONFIG_DOCTOR_MAX_CONFIG_FILE_BYTES = 1;\n`;
			const findings = collectFindings({
				schemaKeys: SCHEMA_KEYS,
				declarations,
				tree: makeTree({
					'src/alpha-reader.ts': READER,
					[DOCTOR_FILE]: doctorSrc,
				}),
			});
			expect(
				findings.some(
					(f) => f.kind === 'doctor-file-only' && f.key === 'alpha',
				),
				`doctor-only via ${symbol} must fail`,
			).toBe(true);
		}
	});

	it('doctor-file path aliases are still recognized as doctor citations', () => {
		const findings = collectFindings({
			schemaKeys: SCHEMA_KEYS,
			declarations: {
				alpha: {
					consumers: ['src/../src/services/config-doctor.ts:validateConfigKey'],
				},
				beta: { inert: 'x' },
				gamma: { consumers: ['src/alpha-reader.ts:readAlpha'] },
			},
			tree: treeFor(),
		});
		expect(
			findings.some((f) => f.kind === 'doctor-file-only' && f.key === 'alpha'),
		).toBe(true);
	});
});
