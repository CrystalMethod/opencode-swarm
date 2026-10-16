import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectFragmentPathParity } from '../../../scripts/drift-check.ts';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Issue #2955: the fragment-path-parity detector test battery. Kept in its own
// file rather than appended to drift-check.test.ts, which already sat at 422
// lines against the FR-006 500-line cap. The harness mirrors the parent
// file's makeTempRoot/writeFile pattern (fresh temp root per test, removed in
// afterEach), on canonicalMkdtemp per FR-011. drift-check.test.ts itself is
// untouched by #2955 — nothing was moved out of it.

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
			cleanPrStandards().replace(anchor, 'echo reverted'),
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

	test('3291 release-and-publish zero-invocation revert trips the site minimum', () => {
		const root = makeTempRoot();
		writeFile(root, '.github/workflows/pr-standards.yml', cleanPrStandards());
		writeFile(
			root,
			'.github/workflows/release-and-publish.yml',
			`name: y\njobs:\n  cleanup:\n    steps:\n      - run: echo no classifier here\n`,
		);
		const findings = detectFragmentPathParity(root);
		const hit = findings.find(
			(f) =>
				f.severity === 'error' &&
				f.file === '.github/workflows/release-and-publish.yml' &&
				f.message.includes('minimum 1'),
		);
		expect(hit).toBeDefined();
	});

	test('3291 matcher tolerance: reworded and partial re-introductions fire', () => {
		// The anchored clean fixtures keep the anchor-count arm satisfied so
		// the ONLY error that can appear is the predicate arm on the probe
		// file — filtering on the zz file name (not just 'hand-maintained',
		// which the anchor message also contains) keeps the test honest.
		for (const alt of [
			'^(src|bin|scripts)/',
			'^((binaries|src|scripts)/)',
			'^(src/|bin/|scripts/|tests/|test/|runners/|examples/)',
			'^(src|bin)/',
		]) {
			const root = makeTempRoot();
			writeFile(root, '.github/workflows/pr-standards.yml', cleanPrStandards());
			writeFile(
				root,
				'.github/workflows/release-and-publish.yml',
				`name: y\njobs:\n  cleanup:\n    steps:\n      - run: paths | ${anchor}\n`,
			);
			writeFile(
				root,
				'.github/workflows/zz-probe.yml',
				`name: probe\njobs:\n  a:\n    steps:\n      - run: |\n          if ! grep -Eq '${alt}' <<< "$changed"; then exit 0; fi\n`,
			);
			const hit = detectFragmentPathParity(root).find(
				(f) =>
					f.severity === 'error' &&
					f.file === '.github/workflows/zz-probe.yml' &&
					f.message.includes('path predicate re-introduced'),
			);
			expect(hit).toBeDefined();
		}
	});

	test('3291 matcher tolerance: the existing-suite extension shape fires via the byte-exact arm', () => {
		const root = makeTempRoot();
		writeFile(root, '.github/workflows/pr-standards.yml', cleanPrStandards());
		writeFile(
			root,
			'.github/workflows/release-and-publish.yml',
			`name: y\njobs:\n  cleanup:\n    steps:\n      - run: paths | ${anchor}\n`,
		);
		writeFile(
			root,
			'.github/workflows/zz-probe.yml',
			`name: probe\njobs:\n  a:\n    steps:\n      - run: |\n          if ! grep -Eq '^(src/|bin/|scripts/|tests/|test/|runners/|examples/|binaries/|package\\.json)' <<< "$changed"; then exit 0; fi\n`,
		);
		const hit = detectFragmentPathParity(root).find(
			(f) =>
				f.severity === 'error' &&
				f.file === '.github/workflows/zz-probe.yml' &&
				f.message.includes('path predicate re-introduced'),
		);
		// The purity arm is dark here (the package\\.json member is not a
		// legacy token); the byte-exact substring disjunct must fire.
		expect(hit).toBeDefined();
	});

	test('3291 matcher tolerance: legitimate single prefixes and mixed filters stay dark', () => {
		for (const alt of [
			'^src/',
			'^(src/worktree/|src/turbo/|docs/|scripts/|tests/fixtures/memory-recall-heldout/|runners/|\\.github/workflows/)',
		]) {
			const root = makeTempRoot();
			writeFile(root, '.github/workflows/pr-standards.yml', cleanPrStandards());
			writeFile(
				root,
				'.github/workflows/release-and-publish.yml',
				`name: y\njobs:\n  cleanup:\n    steps:\n      - run: paths | ${anchor}\n`,
			);
			writeFile(
				root,
				'.github/workflows/zz-probe.yml',
				`name: probe\njobs:\n  b:\n    steps:\n      - run: |\n          grep -E '${alt}' <<< "$paths"\n`,
			);
			const hits = detectFragmentPathParity(root).filter(
				(f) =>
					f.severity === 'error' &&
					f.file === '.github/workflows/zz-probe.yml' &&
					f.message.includes('path predicate re-introduced'),
			);
			expect(hits).toEqual([]);
		}
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
		// A NON-comment line carrying only the bare flag, plus one real
		// invocation: the anchor requires the full invocation form, so the
		// count stays at 1 (< the pr-standards minimum of 2). Pins that a bare
		// `--print-requirement` mention — in a string, an echo, a dead step —
		// cannot stand in for a consumer.
		writeFile(
			root,
			'.github/workflows/pr-standards.yml',
			`jobs:\n  a:\n    steps:\n      - run: x | echo "--print-requirement"\n      - run: y | ${anchor}\n`,
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

	test('a comment quoting the full invocation form is not a consumer anchor either', () => {
		const root = makeTempRoot();
		// One real invocation plus a decoy comment carrying the FULL form:
		// the counter skips comment lines, so the count stays at 1 (< 2).
		writeFile(
			root,
			'.github/workflows/pr-standards.yml',
			`# runs via ${anchor} in the other arm
jobs:
  a:
    steps:
      - run: x | ${anchor}
`,
		);
		const findings = detectFragmentPathParity(root);
		expect(
			findings.some(
				(f) =>
					f.severity === 'error' &&
					f.file === '.github/workflows/pr-standards.yml' &&
					f.message.includes('minimum 2'),
			),
		).toBe(true);
	});
});
