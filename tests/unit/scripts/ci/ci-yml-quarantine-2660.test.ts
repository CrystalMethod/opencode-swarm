import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression pinning tests for the issue #2660 quarantine entry.
//
// Issue #2660 listed one candidate from a merge-group flake-detection run
// (CI run 34309871068, merge_group, head e2491c3a, 2026-09-09T04:09:35Z):
//   - tests/unit/telemetry/init-rehome.test.ts
//     (ubuntu-latest coverage-shard 1, passed-on-retry flake — must go
//     in the GENERAL ledger because run-coverage-gate.sh never branches
//     per-OS)
//
// Each pinning test below reads the real ledger files off disk and
// asserts the entry is present in the correct ledger and absent from
// the others, that the on-disk file exists, and that the entry block
// carries the OWNER/EXPIRY metadata required by Check 7 (issue #2477).

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

const INIT_REHOME = 'tests/unit/telemetry/init-rehome.test.ts';

// Mirror ci.yml's active-entry extraction exactly:
//   grep -vE '^\s*#|^\s*$' scripts/ci/quarantined-tests-<os>.txt
// (CRLF is normalized first; no trimming — ci.yml's grep/comm matching is
// exact, so a whitespace-padded entry must fail here just as it silently
// fails to exclude in CI. No sort -u dedup either: containment checks only
// need membership, and ci.yml dedupes on the CI side at ci.yml:638.)
function activeEntries(ledgerPath: string): string[] {
	const raw = readFileSync(ledgerPath, 'utf8').replace(/\r\n/g, '\n');
	return raw
		.split('\n')
		.filter((line: string) => !/^\s*#/.test(line) && !/^\s*$/.test(line));
}

describe('quarantine ledger entries for issue #2660 merge-group flake detection', () => {
	describe('init-rehome.test.ts (ubuntu-latest, coverage-shard 1)', () => {
		test('is an active entry in the GENERAL ledger (coverage job is ubuntu-only)', () => {
			// The coverage job runs ubuntu-only and honors ONLY the
			// general ledger (run-coverage-gate.sh rejects per-OS
			// branching — its header at scripts/ci/run-coverage-gate.sh
			// says coverage is ubuntu-only and must never partition by
			// RUNNER_OS). The flake originated on ubuntu-latest
			// coverage-shard 1 (CI run 34309871068, head e2491c3a,
			// 2026-09-09T04:09:35Z, Attempt 1 failed → Passed on retry 1;
			// the detection-run artifact flake-annotations-coverage-shard-1
			// ID 10088150448 carries the sole `::notice ... Passed on
			// retry 1` line for this file).
			expect(existsSync(GENERAL_LEDGER_PATH)).toBe(true);
			expect(activeEntries(GENERAL_LEDGER_PATH)).toContain(INIT_REHOME);
		});

		test('is scoped to the general ledger only (not per-OS, not integration)', () => {
			// The macos/windows ledgers would be a no-op for a coverage
			// job that never runs on those runners; listing it there
			// would imply OS-specific evidence that does not exist.
			// All four ledgers exist on main; assert presence up-front
			// (matching the #2740 pinning test pattern) so a renamed or
			// removed ledger fails loudly instead of silently passing.
			expect(existsSync(MACOS_LEDGER_PATH)).toBe(true);
			expect(existsSync(WINDOWS_LEDGER_PATH)).toBe(true);
			expect(existsSync(INTEGRATION_LEDGER_PATH)).toBe(true);
			expect(activeEntries(MACOS_LEDGER_PATH)).not.toContain(INIT_REHOME);
			expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(INIT_REHOME);
			expect(activeEntries(INTEGRATION_LEDGER_PATH)).not.toContain(INIT_REHOME);
		});

		test('carries OWNER + EXPIRY metadata (issue #2477 Check 7)', () => {
			const raw = readFileSync(GENERAL_LEDGER_PATH, 'utf8').replace(
				/\r\n/g,
				'\n',
			);
			const lines = raw.split('\n');
			const entryIdx = lines.findIndex((l: string) => l.trim() === INIT_REHOME);
			expect(entryIdx).toBeGreaterThan(-1);
			// Mirror checkQuarantineMetadata's upward walk exactly
			// (scripts/check-invariants.ts): the block is the contiguous
			// comment lines DIRECTLY above the entry — a blank line
			// terminates the walk, so metadata behind a blank line does
			// not count. Walking through blank lines here would let this
			// test attribute a foreign block's metadata to this entry
			// and pass while Check 7 fails.
			const blockAbove: string[] = [];
			for (let i = entryIdx - 1; i >= 0; i -= 1) {
				const above = lines[i] ?? '';
				if (above.trim() === '' || !above.trimStart().startsWith('#')) {
					break;
				}
				blockAbove.push(above);
			}
			const block = blockAbove.reverse().join('\n');
			expect(block.includes('# OWNER:')).toBe(true);
			expect(block.match(/#\s*EXPIRY:\s*\d{4}-\d{2}-\d{2}/) !== null).toBe(
				true,
			);
		});

		test('the quarantined path exists and is discoverable by the ci.yml find chain', () => {
			// A typo'd ledger path would be a silent no-op: CI's
			// `comm -23` gated set would never exclude it (the path never
			// appears in all-tests.txt) and the flake would keep
			// re-filing. The unit discovery chain globs
			// tests/unit/**/*.test.ts, so the on-disk file must exist at
			// exactly the ledger path relative to the repo root —
			// existence at a tests/unit/**/*.test.ts-shaped path is what
			// makes the find chain emit it.
			expect(existsSync(join(REPO_ROOT, INIT_REHOME))).toBe(true);
		});
	});
});
