import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	evaluateFragmentCheck,
	evaluateRequirement,
} from '../../../scripts/check-pending-fragment';
import {
	FRAGMENT_SATISFACTION,
	isPendingFragment,
	isUserVisiblePath,
} from '../../../scripts/user-visible-paths';

/**
 * Issue #2955 parity matrix. Before the fix, two required gates classified
 * "does this PR need a release fragment?" with contradictory predicates —
 * the TS classifier (quality) and a triplicated bash regex (pr-standards,
 * release-and-publish) disagreed on 9 path classes in both directions, and
 * on satisfaction semantics (added-only vs added/modified/renamed). This
 * suite pins the single shared-table verdict for every class of the
 * dual-high-19 fixture matrix plus the pre-table behavior rows, so any
 * future table edit that flips a class breaks here before it can re-split
 * the gates.
 *
 * Resolution rule (recorded per class row in USER_VISIBLE_PATH_CLASSES):
 * the TS verdict wins. Classes where the bash regex was WIDER (scripts/,
 * tests/, test/, examples/, bun.lock, bunfig.toml) narrow — those PRs stop
 * being falsely blocked; classes where bash was NARROWER (.github/workflows/,
 * the three skills trees, docs/configuration.md) widen — both gates now go
 * red together on fragment-less PRs in those classes.
 */

const MATRIX: Array<{ label: string; file: string; userVisible: boolean }> = [
	// The 9 formerly divergent classes (#2955 fixture matrix).
	{
		label: 'class-1 scripts/**',
		file: 'scripts/check-required-check-contract.ts',
		userVisible: false,
	},
	{
		label: 'class-2 tests/**',
		file: 'tests/unit/scripts/drift-check.test.ts',
		userVisible: false,
	},
	{ label: 'class-3 test/**', file: 'test/foo.test.ts', userVisible: false },
	{
		label: 'class-4 .github/workflows/**',
		file: '.github/workflows/ci.yml',
		userVisible: true,
	},
	{
		label: 'class-5 skills trees',
		file: '.opencode/skills/swarm/SKILL.md',
		userVisible: true,
	},
	{
		label: 'class-6 examples/**',
		file: 'examples/syntax-check/sample-go-50.go',
		userVisible: false,
	},
	{ label: 'class-7 bun.lock', file: 'bun.lock', userVisible: false },
	{ label: 'class-8 bunfig.toml', file: 'bunfig.toml', userVisible: false },
	{
		label: 'class-9 docs/configuration.md',
		file: 'docs/configuration.md',
		userVisible: true,
	},
	// Agree rows from the fixture matrix.
	{ label: 'agree src/**', file: 'src/index.ts', userVisible: true },
	{ label: 'agree package.json', file: 'package.json', userVisible: true },
	{ label: 'agree README.md', file: 'README.md', userVisible: false },
	// Pre-table behavior rows pinned so the table move stays verbatim
	// (these classes were never divergent but are part of the classifier).
	{ label: 'behavior bin/**', file: 'bin/swarm.js', userVisible: true },
	{
		label: 'behavior binaries/**',
		file: 'binaries/win32-x64/swarm.exe',
		userVisible: true,
	},
	{
		label: 'behavior runners/**',
		file: 'runners/sandbox/index.ts',
		userVisible: true,
	},
	{
		label: 'behavior .zcode/**',
		file: '.zcode/session/swarm-mode.md',
		userVisible: false,
	},
	{
		label: 'behavior node_modules/**',
		file: 'node_modules/zod/index.js',
		userVisible: false,
	},
	{
		label: 'behavior colocated .test.tsx',
		file: 'src/council/x.test.tsx',
		userVisible: false,
	},
	{
		label: 'behavior docs/** non-configuration',
		file: 'docs/council/README.md',
		userVisible: false,
	},
	{
		label: 'behavior windows separators',
		file: 'src\\council\\types.ts',
		userVisible: true,
	},
	{
		label: 'behavior ./-prefixed path',
		file: './src/index.ts',
		userVisible: true,
	},
];

describe('issue #2955 parity matrix', () => {
	test.each(MATRIX)('$label yields the single recorded verdict ($file)', ({
		file,
		userVisible,
	}) => {
		expect(isUserVisiblePath(file)).toBe(userVisible);
	});

	test('divergence count is zero: every matrix row has exactly one verdict', () => {
		// The matrix IS the recorded resolution; a table row flip changes the
		// classifier output and fails the test.each above. This row makes the
		// intent explicit and keeps a named count assertion in the file.
		expect(
			MATRIX.filter((row) => isUserVisiblePath(row.file) !== row.userVisible),
		).toEqual([]);
		expect(MATRIX.length).toBe(21);
	});
});

describe('issue #2955 no hand-maintained fragment regex remains', () => {
	test('zero legacy-regex mentions under .github/workflows, including comments', () => {
		// Matches frozen check C2's matcher and the drift detector arm: no
		// line in any workflow file may carry the legacy hand-maintained
		// path-classification literal — not even a comment quoting it.
		const workflowsDir = path.join(
			import.meta.dir,
			'..',
			'..',
			'..',
			'.github',
			'workflows',
		);
		const offenders: string[] = [];
		for (const entry of fs.readdirSync(workflowsDir)) {
			if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) continue;
			const lines = fs
				.readFileSync(path.join(workflowsDir, entry), 'utf8')
				.split('\n');
			lines.forEach((line, index) => {
				if (
					line.includes(
						'src/|bin/|scripts/|tests/|test/|runners/|examples/|binaries/',
					)
				) {
					offenders.push(`${entry}:${index + 1}`);
				}
			});
		}
		expect(offenders).toEqual([]);
	});
});

describe('issue #2955 fragment satisfaction is added-only (AMR-vs-A resolved)', () => {
	test('FRAGMENT_SATISFACTION records the resolution', () => {
		expect(FRAGMENT_SATISFACTION).toBe('added-only');
	});

	test('a modify-only pending fragment does NOT satisfy the mandate', () => {
		const changed = ['src/index.ts', 'docs/releases/pending/other-pr.md'];
		const added: string[] = [];
		expect(
			evaluateFragmentCheck({ changedFiles: changed, addedFiles: added })
				.violation,
		).toBe(true);
		expect(evaluateRequirement(changed, added)).toEqual({
			required: true,
			satisfied: false,
			violation: true,
		});
	});

	test('a deleted pending fragment does NOT satisfy the mandate', () => {
		const changed = ['src/index.ts', 'docs/releases/pending/gone.md'];
		const added: string[] = [];
		expect(evaluateRequirement(changed, added).satisfied).toBe(false);
	});

	test('an added (or copied-in) pending fragment satisfies the mandate', () => {
		const changed = ['src/index.ts', 'docs/releases/pending/mine.md'];
		const added = ['docs/releases/pending/mine.md'];
		expect(
			evaluateFragmentCheck({ changedFiles: changed, addedFiles: added })
				.violation,
		).toBe(false);
		expect(evaluateRequirement(changed, added)).toEqual({
			required: true,
			satisfied: true,
			violation: false,
		});
	});

	test('not-required PRs pass regardless of fragments', () => {
		const changed = ['scripts/foo.ts', 'tests/unit/x.test.ts'];
		expect(evaluateRequirement(changed, []).violation).toBe(false);
		expect(evaluateRequirement([], []).violation).toBe(false);
	});

	test('isPendingFragment requires the pending dir and .md suffix', () => {
		expect(isPendingFragment('docs/releases/pending/a.md')).toBe(true);
		expect(isPendingFragment('docs/releases/pending/sub/b.md')).toBe(true);
		expect(isPendingFragment('docs/releases/pending/a.txt')).toBe(false);
		expect(isPendingFragment('docs/releases/v7.0.0.md')).toBe(false);
		expect(isPendingFragment('README.md')).toBe(false);
	});
});
