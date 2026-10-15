import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectFragmentPathParity } from '../../../scripts/drift-check.ts';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Issue #2955: the fragment-path-parity detector test battery. Split out of
// drift-check.test.ts to stay under the FR-006 500-line cap; the harness
// mirrors the parent file's makeTempRoot/writeFile pattern (fresh temp root
// per test, removed in afterEach), on canonicalMkdtemp per FR-011.

const tempRoots: string[] = [];

function makeTempRoot(): string {
	const root = canonicalMkdtemp('drift-check-parity-');
	tempRoots.push(root);
	return root;
}

function writeFile(root: string, relativePath: string, contents: string): void {
	const full = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, contents, 'utf-8');
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('drift-check: fragment-path-parity detection (issue #2955)', () => {
	const anchor = 'bun scripts/check-pending-fragment.ts --print-requirement';

	function cleanPrStandards(): string {
		return `name: PR Standards\njobs:\n  pr-standards:\n    steps:\n      - run: changed | ${anchor} --added f.md\n      - run: more | ${anchor}\n`;
	}

	test('detects a re-introduced hand-maintained fragment regex', () => {
		const root = makeTempRoot();
		writeFile(
			root,
			'.github/workflows/pr-standards.yml',
			`name: x\njobs:\n  a:\n    steps:\n      - run: |\n          if ! grep -Eq '^(src/|bin/|scripts/|tests/|test/|runners/|examples/|binaries/|package\\.json)' <<< "$changed"; then exit 0; fi\n`,
		);
		const findings = detectFragmentPathParity(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' &&
				f.category === 'fragment-path-parity' &&
				f.message.includes('FRAGMENT_PATH_PARITY'),
		);
		expect(hit).toBeDefined();
	});

	test('detects single-arm reversion below the per-site anchor minimum', () => {
		const root = makeTempRoot();
		// Only ONE classifier invocation in pr-standards.yml (minimum is 2):
		// reverting one arm to hand-maintained classification trips the count.
		writeFile(
			root,
			'.github/workflows/pr-standards.yml',
			cleanPrStandards().replace(anchor, 'echo reverted', ''),
		);
		writeFile(
			root,
			'.github/workflows/release-and-publish.yml',
			`name: y\njobs:\n  cleanup:\n    steps:\n      - run: paths | ${anchor}\n`,
		);
		const findings = detectFragmentPathParity(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' &&
				f.file === '.github/workflows/pr-standards.yml' &&
				f.message.includes('minimum 2'),
		);
		expect(hit).toBeDefined();
	});

	test('clean fixtures produce no findings and missing pinned files are notices', () => {
		const root = makeTempRoot();
		writeFile(root, '.github/workflows/pr-standards.yml', cleanPrStandards());
		writeFile(
			root,
			'.github/workflows/release-and-publish.yml',
			`name: y\njobs:\n  cleanup:\n    steps:\n      - run: paths | ${anchor}\n`,
		);
		expect(
			detectFragmentPathParity(root).filter((f) => f.severity === 'error'),
		).toEqual([]);

		// Trimmed fork: release-and-publish.yml absent -> notice, not error.
		const trimmed = makeTempRoot();
		writeFile(
			trimmed,
			'.github/workflows/pr-standards.yml',
			cleanPrStandards(),
		);
		const notices = detectFragmentPathParity(trimmed);
		expect(notices.some((f) => f.severity === 'notice')).toBe(true);
		expect(notices.filter((f) => f.severity === 'error')).toEqual([]);
	});

	test('a bare flag mention does not count as a consumer anchor', () => {
		const root = makeTempRoot();
		// A comment mentioning the flag plus one real invocation: still below
		// the pr-standards minimum of 2 because the anchor matcher requires
		// the full invocation form.
		writeFile(
			root,
			'.github/workflows/pr-standards.yml',
			`# see --print-requirement\njobs:\n  a:\n    steps:\n      - run: x | ${anchor}\n`,
		);
		const findings = detectFragmentPathParity(root);
		expect(
			findings.some(
				(f) =>
					f.severity === 'error' &&
					f.file === '.github/workflows/pr-standards.yml',
			),
		).toBe(true);
	});
});
