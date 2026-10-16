import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	evaluateFragmentCheck,
	evaluateRequirement,
} from '../../../scripts/check-pending-fragment';
import {
	isLegacyPredicateAlternation,
	LEGACY_FRAGMENT_REGEX_SUBSTRING,
} from '../../../scripts/drift-check';
import {
	FRAGMENT_SATISFACTION,
	isPendingFragment,
	isUserVisiblePath,
	USER_VISIBLE_PATH_CLASSES,
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
	// tests/fixtures/** SHIPS (package.json#files), so it is pinned here as a
	// covered surface. Note this row does NOT by itself make the tests/
	// never-prefix row load-bearing — see the table-shape assertion below,
	// which is what actually prevents that row from being dropped.
	{
		label: 'behavior tests/fixtures/** (ships, still not user-visible)',
		file: 'tests/fixtures/memory-recall/corpus.jsonl',
		userVisible: false,
	},
	// #3291: a test/-prefix path whose file does NOT end in .test.ts. The
	// class-3 row above is suffix-masked (its file hits the .test.ts suffix
	// exclusion first). There is deliberately NO test/ (singular) prefix row
	// in the table — this matrix row pins the CURRENT fallthrough verdict for
	// test/-prefixed non-test files, so a future test/ row that flips the
	// verdict fails here (F-10 reword: it pins today's recorded verdict, not
	// a table row that does not exist).
	{
		label: '3291 test/-prefix non-test file',
		file: 'test/helper.ts',
		userVisible: false,
	},
];

describe('issue #2955 table shape', () => {
	// A verdict alone cannot protect a never-prefix row: with the row gone the
	// classifier's fallthrough returns the SAME answer, so deleting it is
	// invisible. (Verified by mutation: dropping the tests/ row left every
	// verdict-level test green.) These assertions pin the rows themselves —
	// the resolution each one records is part of the shared table's contract.
	test.each([
		{ pattern: 'tests/' },
		{ pattern: 'scripts/' },
		{ pattern: '.zcode/' },
		{ pattern: 'node_modules/' },
		{ pattern: 'evaluation-fixtures/' },
		{ pattern: 'dist/' },
	])('the never-prefix row for $pattern exists and is recorded as never user-visible', ({
		pattern,
	}) => {
		const row = USER_VISIBLE_PATH_CLASSES.find(
			(entry) => entry.kind === 'never-prefix' && entry.pattern === pattern,
		);
		expect(row).toBeDefined();
		expect(row?.userVisible).toBe(false);
		// Every never-prefix row carries its #2955 resolution note.
		expect(row?.note.length ?? 0).toBeGreaterThan(20);
	});

	test('every class row is reachable: no duplicate pattern/kind pair', () => {
		const keys = USER_VISIBLE_PATH_CLASSES.map((r) => `${r.kind}:${r.pattern}`);
		expect(new Set(keys).size).toBe(keys.length);
	});
});

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
		expect(MATRIX.length).toBe(23);
	});
});

describe('issue 3291 shipped-surface census', () => {
	test('3291 census: every package.json#files entry is a recorded decision', () => {
		// F-1 (issue #3291 round 2): the census is STRICT — an entry is covered
		// iff a row matches under classifier semantics (with the bare-name
		// prefix fallback for prefix/never-prefix rows), possibly via an
		// ancestor row. There is deliberately NO text-mention fallback: a
		// bare comment naming a path must never pass for a recorded decision.
		const repoRoot = path.resolve(import.meta.dir, '..', '..', '..');
		const manifest = JSON.parse(
			fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
		) as { files: string[] };
		function rowMatches(candidate: string): boolean {
			for (const row of USER_VISIBLE_PATH_CLASSES) {
				if (row.kind === 'exact' && candidate === row.pattern) return true;
				if (
					(row.kind === 'prefix' || row.kind === 'never-prefix') &&
					(candidate.startsWith(row.pattern) ||
						candidate === row.pattern.replace(/\/$/, ''))
				) {
					return true;
				}
			}
			return false;
		}
		function covered(entry: string): boolean {
			if (rowMatches(entry)) return true;
			let ancestor = path.posix.dirname(entry);
			while (ancestor !== '.' && ancestor !== '/') {
				if (rowMatches(ancestor)) return true;
				ancestor = path.posix.dirname(ancestor);
			}
			return false;
		}
		const uncovered = manifest.files.filter((entry) => !covered(entry));
		expect(uncovered).toEqual([]);
	});

	test('3291 census: the recorded decisions classify not-user-visible', () => {
		expect(isUserVisiblePath('evaluation-fixtures/case.json')).toBe(false);
		expect(isUserVisiblePath('evaluation-fixtures/sub/dir/data.json')).toBe(
			false,
		);
		expect(isUserVisiblePath('opencode-swarm.schema.json')).toBe(false);
		expect(isUserVisiblePath('README.md')).toBe(false);
		expect(isUserVisiblePath('LICENSE')).toBe(false);
		expect(isUserVisiblePath('dist/index.js')).toBe(false);
	});

	test('3291 census: the recorded-decision rows are load-bearing (PRR-006/F-5)', () => {
		// F-5: a never-prefix/exact row must be pinned by more than the
		// classifier's fallthrough. The census's STRICT row-match arm is the
		// pin — proved here by deletion: with the row removed from the table,
		// its own recorded surface becomes uncovered (the census test above
		// would go red on a real deletion).
		function rowMatchesExcluding(pattern: string, candidate: string): boolean {
			for (const row of USER_VISIBLE_PATH_CLASSES) {
				if (row.pattern === pattern) continue;
				if (row.kind === 'exact' && candidate === row.pattern) return true;
				if (
					(row.kind === 'prefix' || row.kind === 'never-prefix') &&
					(candidate.startsWith(row.pattern) ||
						candidate === row.pattern.replace(/\/$/, ''))
				) {
					return true;
				}
			}
			return false;
		}
		for (const [pattern, probe] of [
			['evaluation-fixtures/', 'evaluation-fixtures/sub/data.json'],
			['opencode-swarm.schema.json', 'opencode-swarm.schema.json'],
			['README.md', 'README.md'],
			['LICENSE', 'LICENSE'],
			['dist/', 'dist/index.js'],
		] as const) {
			expect(rowMatchesExcluding(pattern, probe)).toBe(false);
		}
	});

	test('3291 census: the bin/ row note is true of the shipping configuration', () => {
		const repoRoot = path.resolve(import.meta.dir, '..', '..', '..');
		const manifest = JSON.parse(
			fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
		) as { files: string[]; bin: Record<string, string> };
		expect(manifest.files).not.toContain('bin');
		expect(manifest.files).not.toContain('bin/');
		expect(Object.values(manifest.bin)[0]).toContain('dist/cli/index.js');
		const binRow = USER_VISIBLE_PATH_CLASSES.find(
			(row) => row.pattern === 'bin/',
		);
		expect(binRow).toBeDefined();
		expect(binRow?.note).toContain('dist/cli/index.js');
		expect(binRow?.note).not.toContain('shipped binaries');
	});

	test('3291 census: row notes with manifest claims are true (F-8)', () => {
		const repoRoot = path.resolve(import.meta.dir, '..', '..', '..');
		const manifest = JSON.parse(
			fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
		) as { files: string[] };
		// scripts/ note: "is NOT in package.json#files"
		expect(manifest.files).not.toContain('scripts');
		// tests/ note names the two shipped fixture subtrees
		expect(manifest.files).toContain('tests/fixtures/memory-recall');
		expect(manifest.files).toContain('tests/fixtures/memory-recall-heldout');
		// evaluation-fixtures/ and schema notes: both are shipped entries
		expect(manifest.files).toContain('evaluation-fixtures');
		expect(manifest.files).toContain('opencode-swarm.schema.json');
		// dist/ note: "package.json#files ships it" and "never committed"
		expect(manifest.files).toContain('dist');
		const committed = Bun.spawnSync({
			cmd: ['git', 'ls-files', 'dist'],
			cwd: repoRoot,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 10_000,
		});
		// A failed spawn also yields empty stdout, so assert the exit code
		// first or the note-truth check below passes vacuously.
		expect(committed.exitCode).toBe(0);
		expect(committed.stdout.toString().trim()).toBe('');
	});
});

describe('issue #2955 no hand-maintained fragment regex remains', () => {
	test('zero legacy-regex mentions under .github/workflows, including comments', () => {
		// Mirrors the frozen check C2's matcher and the drift detector arm —
		// BOTH disjuncts (issue #3291 NEW-1): the byte-exact constant and the
		// purity arm. No line in any workflow file may carry the legacy
		// hand-maintained classification predicate in either shape.
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
				// The production detector arms, not copies: weakening either in
				// scripts/drift-check.ts must fail THIS test too.
				if (
					line.includes(LEGACY_FRAGMENT_REGEX_SUBSTRING) ||
					isLegacyPredicateAlternation(line)
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
