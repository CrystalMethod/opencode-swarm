import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression pinning tests for the issue #2761 quarantine entries.
//
// Issue #2761 was auto-filed by the merge-group flake-detection workflow
// (#1782) after CI run 34797415390 (pr-2753, head
// 15dcd7f1731c9e380bf7fbddb95252bca095cf6d, 2026-09-14T01:54Z). It listed
// two candidates:
//   - tests/unit/hooks/pr-workflow-gate-batch-gc.test.ts
//     (CORE-TREE hard failure on unit-shard 1: ::error file=...::FAILED,
//     all 3 in-job attempts timed out under merge-group pressure) -> GENERAL
//     ledger (scripts/ci/quarantined-tests.txt)
//   - tests/unit/index-pr-workflow-session-lifecycle-2602.test.ts
//     (windows-latest unit-shard 5, passed-on-retry-2 flake) -> WINDOWS
//     ledger (scripts/ci/quarantined-tests-windows.txt)
//
// Each pinning test reads the real ledger files off disk and asserts the
// entry is present in the correct ledger and absent from the others, that
// its comment block carries the OWNER/EXPIRY metadata required by
// check:invariants Check 7 (issue #2477), and that the on-disk file exists
// at exactly the ledger path.

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

const ISSUE_2761_QUARANTINED_PATHS: ReadonlyArray<{
	path: string;
	expectedLedger: string;
}> = [
	{
		path: 'tests/unit/hooks/pr-workflow-gate-batch-gc.test.ts',
		expectedLedger: GENERAL_LEDGER_PATH,
	},
	{
		path: 'tests/unit/index-pr-workflow-session-lifecycle-2602.test.ts',
		expectedLedger: WINDOWS_LEDGER_PATH,
	},
];

// Mirror ci.yml's active-entry extraction exactly:
//   grep -vE '^\s*#|^\s*$' scripts/ci/quarantined-tests-<os>.txt
// Entries are compared UNTRIMMED (CI's grep/comm matching is byte-exact, so a
// whitespace-corrupted entry must fail here too); CRLF is normalized first so
// the assertion holds on any checkout config.
function activeEntries(ledgerPath: string): string[] {
	const raw = readFileSync(ledgerPath, 'utf8').replace(/\r\n/g, '\n');
	return raw
		.split('\n')
		.filter((line: string) => !/^\s*#/.test(line) && !/^\s*$/.test(line));
}

// Collect the contiguous comment block directly above an entry (issue #2477
// metadata grammar: `# OWNER:` / `# EXPIRY:` must sit in that block).
function commentBlockAbove(ledgerPath: string, entry: string): string {
	const lines = readFileSync(ledgerPath, 'utf8')
		.replace(/\r\n/g, '\n')
		.split('\n');
	const entryIdx = lines.findIndex((line) => line.trim() === entry);
	if (entryIdx === -1) return '';
	const blockAbove: string[] = [];
	for (let i = entryIdx - 1; i >= 0; i -= 1) {
		const above = lines[i] ?? '';
		if (above.trim() === '' || /^\s*#/.test(above)) {
			blockAbove.push(above);
		} else {
			break;
		}
	}
	return blockAbove.reverse().join('\n');
}

describe('ci.yml integration — quarantine ledger entries for issue #2761 merge-group flake detection', () => {
	test.each(
		ISSUE_2761_QUARANTINED_PATHS,
	)('$path is retired from its ledger (#2973)', ({
		path: quarantinedPath,
		expectedLedger,
	}) => {
		// #2973 retirement (2026-09-27): the 2602 lifecycle entry's
		// safeRmRecursive fix had already landed (PR #2807) and the batch-gc
		// entry's slowness was floor-raised to 150s by the retiring PR.
		// Absence guard: no silent re-add without fresh merge-group
		// failure evidence.
		expect(existsSync(expectedLedger)).toBe(true);
		expect(activeEntries(expectedLedger)).not.toContain(quarantinedPath);
	});

	test.each(
		ISSUE_2761_QUARANTINED_PATHS,
	)('$path is scoped to its ledger only (no cross-ledger duplicate)', ({
		path: quarantinedPath,
		expectedLedger,
	}) => {
		// Cross-ledger duplicates would falsely imply OS-specific or
		// integration evidence: the pr-workflow-gate-batch-gc flake is a
		// cross-OS timing failure (general ledger applies on every
		// RUNNER_OS), and the 2602 lifecycle flake is windows-latest-only
		// with green ubuntu/macos siblings (the windows ledger applies on
		// Windows runners only, per the "Collect and partition test files"
		// step), so it must NOT suppress the file on other OSes.
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
		ISSUE_2761_QUARANTINED_PATHS,
	)('$path leaves no stale entry line or OWNER/EXPIRY block (#2973)', ({
		path: quarantinedPath,
		expectedLedger,
	}) => {
		// The entries were removed by the #2973 retirement, so no ledger
		// line for the path may remain (a surviving entry line — with its
		// OWNER/EXPIRY comment block — would be an orphan the removal
		// missed; commentBlockAbove returning '' alone would not distinguish
		// a removed entry from a metadata-stripped one).
		const lines = readFileSync(expectedLedger, 'utf8')
			.replace(/\r\n/g, '\n')
			.split('\n');
		expect(lines.some((line) => line.trim() === quarantinedPath)).toBe(false);
	});

	test.each(
		ISSUE_2761_QUARANTINED_PATHS,
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
});
