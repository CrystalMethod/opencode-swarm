import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Repo root is four levels up from tests/unit/scripts/ci/.
const REPO_ROOT = join(import.meta.dir, '../../../..');
const GENERAL_LEDGER_PATH = join(REPO_ROOT, 'scripts/ci/quarantined-tests.txt');
const MACOS_LEDGER_PATH = join(
	REPO_ROOT,
	'scripts/ci/quarantined-tests-macos.txt',
);
const WINDOWS_LEDGER_PATH = join(
	REPO_ROOT,
	'scripts/ci/quarantined-tests-windows.txt',
);
const INTEGRATION_LEDGER_PATH = join(
	REPO_ROOT,
	'scripts/ci/quarantined-integration-tests.txt',
);

// Originally three paths quarantined by issue #2740; two were since
// RE-QUARANTINED with fresh failure evidence — bun-compat-exit-first-2530
// per #3248 (pinned by ci-yml-quarantine-2730.test.ts) and
// evidence-summary-adversarial per #3261 (2026-10-14, run 38623951150,
// ubuntu-latest unit-shard 3 heap-growth probe; re-added to the general
// ledger, which the unit job honors on every OS). Only promote-registration
// remains retired and pinned below. Originally: The merge-group flake-detection
// workflow (#1782) flagged all three with `Passed on retry` annotations in
// run 34726206593; per the quarantine-placement policy in
// docs/testing/test-stability.md, the
// ubuntu-latest flake lands in the general ledger (no ubuntu-specific ledger
// exists; #2368 dispatch-lanes precedent) and the two macos-latest flakes
// land in the macOS ledger (windows ledger re-add policy requires a windows
// merge-group confirmed failure; sibling OS shards were green).
//
// #3248 re-add: bun-compat-exit-first-2530 was retired by #2973 but has
// since accumulated the "fresh merge-group macos-latest failure evidence"
// the retirement's absence-guard requires (hard failures on runs
// 38449931439 + 38421990284, both `unit (macos-latest, 5)`, with a new
// early-clean-exit signature the 30s PROBE_TIMEOUT_MS remedy does not
// cover). It is now ACTIVE in the macOS ledger; the other two #2740
// paths remain retired.
const ISSUE_2740_RETIRED_PATHS: ReadonlyArray<{
	path: string;
	expectedLedger: string;
}> = [
	{
		path: 'tests/unit/commands/promote-registration.test.ts',
		expectedLedger: MACOS_LEDGER_PATH,
	},
];

const BUN_COMPAT_EXIT_FIRST =
	'tests/unit/utils/bun-compat-exit-first-2530.test.ts';

// Mirror ci.yml's active-entry extraction exactly:
//   grep -vE '^\s*#|^\s*$' scripts/ci/quarantined-tests-<os>.txt
// (CRLF is normalized first; no trimming — ci.yml's grep/comm matching is
// exact, so a whitespace-padded entry must fail here just as it silently
// fails to exclude in CI.)
function activeEntries(ledgerPath: string): string[] {
	const raw = readFileSync(ledgerPath, 'utf8').replace(/\r\n/g, '\n');
	return raw
		.split('\n')
		.filter((line: string) => !/^\s*#/.test(line) && !/^\s*$/.test(line));
}

describe('ci.yml integration — quarantine ledger entries for issue #2740', () => {
	test.each(
		ISSUE_2740_RETIRED_PATHS,
	)('$path is retired from its ledger (#2973)', ({
		path: quarantinedPath,
		expectedLedger,
	}) => {
		// #2973 retirement (2026-09-27): each path's named remedy landed in
		// the retiring PR (evidence-summary budget widened to 2000ms;
		// promote-registration canonical mkdtemp + safeRmRecursive teardown).
		// Absence guard: no silent re-add without fresh merge-group failure
		// evidence.
		expect(existsSync(expectedLedger)).toBe(true);
		expect(activeEntries(expectedLedger)).not.toContain(quarantinedPath);
	});

	test.each(
		ISSUE_2740_RETIRED_PATHS,
	)('$path is scoped to its ledger only (no cross-ledger duplicate)', ({
		path: quarantinedPath,
		expectedLedger,
	}) => {
		// Cross-ledger duplicates would falsely imply OS-specific or
		// integration evidence: the evidence-summary flake is
		// single-detection on ubuntu-latest (general ledger applies on
		// every RUNNER_OS), and promote-registration must NOT suppress the
		// file on other OSes (the macOS ledger applies on macOS runners
		// only, per the "Collect and partition test files" step).
		const otherLedgers = [
			GENERAL_LEDGER_PATH,
			MACOS_LEDGER_PATH,
			WINDOWS_LEDGER_PATH,
			INTEGRATION_LEDGER_PATH,
		].filter((ledger) => ledger !== expectedLedger);
		for (const ledger of otherLedgers) {
			expect(activeEntries(ledger)).not.toContain(quarantinedPath);
		}
	});

	test.each(
		ISSUE_2740_RETIRED_PATHS,
	)('$path exists on disk and is discovered by the ci.yml find chain', ({
		path: quarantinedPath,
	}) => {
		// A typo'd ledger path would be a silent no-op: CI's comm -23 gated
		// set would never exclude it (the path never appears in all-tests.txt)
		// and the flake-detection workflow would keep re-filing. The unit
		// discovery chain globs tests/unit/**/*.test.ts, so the on-disk file
		// must exist at exactly the ledger path relative to the repo root.
		expect(existsSync(join(REPO_ROOT, quarantinedPath))).toBe(true);
	});

	test(`${BUN_COMPAT_EXIT_FIRST} is ACTIVE in the macOS ledger again (#3248 re-add)`, () => {
		expect(existsSync(MACOS_LEDGER_PATH)).toBe(true);
		expect(activeEntries(MACOS_LEDGER_PATH)).toContain(BUN_COMPAT_EXIT_FIRST);
	});

	test(`${BUN_COMPAT_EXIT_FIRST} is present exactly once in its ledger (PRR-029)`, () => {
		// A duplicate entry with its own OWNER/EXPIRY block would leave two
		// competing owners for renewal while every membership pin stays green
		// (the sibling 2730 pins enforce exactly-once for their entries).
		const entries = activeEntries(MACOS_LEDGER_PATH).filter(
			(entry) => entry === BUN_COMPAT_EXIT_FIRST,
		);
		expect(entries.length).toBe(1);
	});

	test(`${BUN_COMPAT_EXIT_FIRST} re-add carries the Check 7 OWNER/EXPIRY metadata`, () => {
		// The SAME contiguous-comment-block walk scripts/check-invariants.ts
		// Check 7 performs (check-invariants.ts:1442): walk upward from the
		// active entry and BREAK at the first blank or non-comment line —
		// a blank line between the metadata block and the entry must fail
		// this pin exactly as it fails Check 7 (PRR-019 mutation parity).
		const raw = readFileSync(MACOS_LEDGER_PATH, 'utf8').replace(/\r\n/g, '\n');
		const lines = raw.split('\n');
		const entryIdx = lines.findIndex(
			(l: string) => l.trim() === BUN_COMPAT_EXIT_FIRST,
		);
		expect(entryIdx).toBeGreaterThan(-1);
		const blockAbove: string[] = [];
		for (let i = entryIdx - 1; i >= 0; i -= 1) {
			const above = lines[i] ?? '';
			if (above.trim() === '' || !above.trimStart().startsWith('#')) {
				break;
			}
			blockAbove.unshift(above);
		}
		const block = blockAbove.join('\n');
		expect(/^#\s*OWNER:\s*\S/m.test(block)).toBe(true);
		expect(/^#\s*EXPIRY:\s*\d{4}-\d{2}-\d{2}\b/m.test(block)).toBe(true);
	});

	test(`${BUN_COMPAT_EXIT_FIRST} stays scoped to the macOS ledger only (no cross-ledger duplicate)`, () => {
		const otherLedgers = [
			GENERAL_LEDGER_PATH,
			WINDOWS_LEDGER_PATH,
			INTEGRATION_LEDGER_PATH,
		];
		for (const ledger of otherLedgers) {
			expect(activeEntries(ledger)).not.toContain(BUN_COMPAT_EXIT_FIRST);
		}
	});

	test(`${BUN_COMPAT_EXIT_FIRST} exists on disk and is discovered by the ci.yml find chain`, () => {
		expect(existsSync(join(REPO_ROOT, BUN_COMPAT_EXIT_FIRST))).toBe(true);
	});
});
