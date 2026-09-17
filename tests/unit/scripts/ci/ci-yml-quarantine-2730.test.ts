import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression pinning tests for the issue #2730 quarantine disposition.
//
// Issue #2730 listed 4 candidates from a merge-group flake-detection run
// (CI run 34670762927, head 1499a74b, 2026-09-12T04:27:48Z → 04:34:14Z).
// Their dispositions, after sibling auto-fix PRs merged while this PR was
// in review:
//   - tests/unit/hooks/pr-feedback-scope-controller.test.ts
//     (macos-latest unit-shard 1, passed-on-retry flake — the ONLY
//     candidate without an owning entry; THIS PR adds it to
//     scripts/ci/quarantined-tests-macos.txt)
//   - tests/unit/scripts/ci/repository-validation-real-process-2675.test.ts
//     (macos-latest unit-shard 1, hard fail — already quarantined in
//     scripts/ci/quarantined-tests-macos.txt by issue #2738, commit
//     ad8c53ae3; this PR must NOT add a second entry)
//   - tests/unit/telemetry/init-rehome.test.ts
//     (ubuntu-latest coverage-shard 3, passed-on-retry flake — already
//     quarantined in the GENERAL ledger by issue #2660 / PR #2799,
//     which is the only ledger the ubuntu-only coverage job honors; this
//     PR must NOT duplicate it)
//   - tests/unit/utils/bun-compat-exit-first-2530.test.ts
//     (macos-latest unit-shard 5, hard fail both attempts — already
//     quarantined in the macOS ledger by issue #2740 / PR #2769; this
//     PR must NOT duplicate it)
//
// Each pinning test below reads the real ledger files off disk and
// asserts the owning entry is present exactly once in the correct
// ledger and absent from the others, that the on-disk file exists, and
// that the entry block carries the OWNER/EXPIRY metadata required by
// Check 7 (issue #2477).

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

const PR_FEEDBACK_SCOPE_CONTROLLER =
	'tests/unit/hooks/pr-feedback-scope-controller.test.ts';
const INIT_REHOME = 'tests/unit/telemetry/init-rehome.test.ts';
const BUN_COMPAT_EXIT_FIRST =
	'tests/unit/utils/bun-compat-exit-first-2530.test.ts';
const REPO_VALIDATION_REAL_PROCESS_2675 =
	'tests/unit/scripts/ci/repository-validation-real-process-2675.test.ts';

// Mirror ci.yml's active-entry extraction exactly:
//   grep -vE '^\s*#|^\s*$' scripts/ci/quarantined-tests-<os>.txt
// (CRLF is normalized first so the assertion holds on any checkout config.)
function activeEntries(ledgerPath: string): string[] {
	const raw = readFileSync(ledgerPath, 'utf8').replace(/\r\n/g, '\n');
	return raw
		.split('\n')
		.filter((line: string) => !/^\s*#/.test(line) && !/^\s*$/.test(line))
		.map((line: string) => line.trim());
}

// Collect the contiguous comment block directly above an active entry,
// the same walk scripts/check-invariants.ts Check 7 performs.
function metadataBlock(ledgerPath: string, entry: string): string {
	const raw = readFileSync(ledgerPath, 'utf8').replace(/\r\n/g, '\n');
	const lines = raw.split('\n');
	const entryIdx = lines.findIndex((l: string) => l.trim() === entry);
	expect(entryIdx).toBeGreaterThan(-1);
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

function expectCarriesOwnerExpiry(ledgerPath: string, entry: string): void {
	const block = metadataBlock(ledgerPath, entry);
	expect(block.includes('# OWNER:')).toBe(true);
	expect(block.match(/#\s*EXPIRY:\s*\d{4}-\d{2}-\d{2}/) !== null).toBe(true);
}

describe('ci.yml integration — quarantine ledger disposition for issue #2730 merge-group flake detection', () => {
	describe('pr-feedback-scope-controller.test.ts (macos-latest, unit-shard 1) — added by this PR', () => {
		test('is an active entry in the macOS ledger (single-OS evidence)', () => {
			// Without this entry, the flake-detection script keeps
			// re-filing the candidate (Rule A only drops already-quarantined
			// files). The flake originated on macos-latest unit-shard 1
			// (CI run 34670762927, 2026-09-12T03:56:04Z, Attempt 1 failed →
			// Passed on retry 1) with no other OS showing the same flake.
			expect(existsSync(MACOS_LEDGER_PATH)).toBe(true);
			const entries = activeEntries(MACOS_LEDGER_PATH);
			expect(entries).toContain(PR_FEEDBACK_SCOPE_CONTROLLER);
			// Exactly one owning entry: a second block would leave two
			// OWNER/EXPIRY owners competing for renewal.
			expect(
				entries.filter((e) => e === PR_FEEDBACK_SCOPE_CONTROLLER).length,
			).toBe(1);
		});

		test('is scoped to the macOS ledger only (not general, not windows, not integration)', () => {
			// The general ledger applies on every RUNNER_OS — listing it
			// there would suppress the file on ubuntu/windows too, but the
			// flake was macos-only; the windows and integration ledgers
			// apply on their respective runners and would similarly over-
			// suppress.
			expect(activeEntries(GENERAL_LEDGER_PATH)).not.toContain(
				PR_FEEDBACK_SCOPE_CONTROLLER,
			);
			expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(
				PR_FEEDBACK_SCOPE_CONTROLLER,
			);
			if (existsSync(INTEGRATION_LEDGER_PATH)) {
				expect(activeEntries(INTEGRATION_LEDGER_PATH)).not.toContain(
					PR_FEEDBACK_SCOPE_CONTROLLER,
				);
			}
		});

		test('carries OWNER + EXPIRY metadata (issue #2477 Check 7)', () => {
			// Check 7 hard-fails any active entry missing OWNER/EXPIRY or
			// with EXPIRY lapsed beyond the grace window. Reading the raw
			// file here is more direct than invoking check:invariants and
			// gives a focused, fast RED signal if the next entry edit
			// drops one of the two required lines.
			expectCarriesOwnerExpiry(MACOS_LEDGER_PATH, PR_FEEDBACK_SCOPE_CONTROLLER);
		});

		test('the quarantined path exists and is discovered by the ci.yml find chain', () => {
			// A typo'd ledger path would be a silent no-op: CI's
			// `comm -23` gated set would never exclude it (the path never
			// appears in all-tests.txt) and the flake would keep
			// re-filing. The discovery chain globs tests/unit/**/*.test.ts,
			// so the on-disk file must exist at exactly the ledger path
			// relative to the repo root.
			expect(existsSync(join(REPO_ROOT, PR_FEEDBACK_SCOPE_CONTROLLER))).toBe(
				true,
			);
		});
	});

	describe('init-rehome.test.ts (ubuntu-latest, coverage-shard 3) — already quarantined by issue #2660 / PR #2799', () => {
		test('is an active entry in the GENERAL ledger exactly once', () => {
			// The coverage job runs ubuntu-only and honors ONLY the
			// general ledger (run-coverage-gate.sh never branches per-OS).
			// The entry is owned by issue #2660, not this PR; this PR
			// pins that it stays present (the coverage job keeps
			// suppressing the flake) and unique.
			expect(existsSync(GENERAL_LEDGER_PATH)).toBe(true);
			const entries = activeEntries(GENERAL_LEDGER_PATH);
			expect(entries).toContain(INIT_REHOME);
			expect(entries.filter((e) => e === INIT_REHOME).length).toBe(1);
		});

		test('is scoped to the general ledger only (not duplicated into per-OS or integration ledgers)', () => {
			// The macos/windows ledgers would be a no-op for a coverage
			// job that never runs on those runners; listing it there
			// would imply OS-specific evidence that does not exist.
			expect(activeEntries(MACOS_LEDGER_PATH)).not.toContain(INIT_REHOME);
			expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(INIT_REHOME);
			if (existsSync(INTEGRATION_LEDGER_PATH)) {
				expect(activeEntries(INTEGRATION_LEDGER_PATH)).not.toContain(
					INIT_REHOME,
				);
			}
		});

		test('its owning entry carries OWNER + EXPIRY metadata (issue #2477 Check 7)', () => {
			expectCarriesOwnerExpiry(GENERAL_LEDGER_PATH, INIT_REHOME);
		});

		test('the quarantined path exists and is discovered by the ci.yml find chain', () => {
			expect(existsSync(join(REPO_ROOT, INIT_REHOME))).toBe(true);
		});
	});

	describe('bun-compat-exit-first-2530.test.ts (macos-latest, unit-shard 5, hard fail) — already quarantined by issue #2740 / PR #2769', () => {
		test('is an active entry in the macOS ledger exactly once', () => {
			// The flake originated on macos-latest unit-shard 5
			// (CI run 34670762927, 2026-09-12T03:57:26Z, Attempt 1 failed,
			// Attempt 2 failed → ::error file=...::FAILED). The owning
			// entry is issue #2740's; this PR must not add a second block
			// for the same path.
			expect(existsSync(MACOS_LEDGER_PATH)).toBe(true);
			const entries = activeEntries(MACOS_LEDGER_PATH);
			expect(entries).toContain(BUN_COMPAT_EXIT_FIRST);
			expect(entries.filter((e) => e === BUN_COMPAT_EXIT_FIRST).length).toBe(1);
		});

		test('is scoped to the macOS ledger only (not general, not windows, not integration)', () => {
			expect(activeEntries(GENERAL_LEDGER_PATH)).not.toContain(
				BUN_COMPAT_EXIT_FIRST,
			);
			expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(
				BUN_COMPAT_EXIT_FIRST,
			);
			if (existsSync(INTEGRATION_LEDGER_PATH)) {
				expect(activeEntries(INTEGRATION_LEDGER_PATH)).not.toContain(
					BUN_COMPAT_EXIT_FIRST,
				);
			}
		});

		test('its owning entry carries OWNER + EXPIRY metadata (issue #2477 Check 7)', () => {
			expectCarriesOwnerExpiry(MACOS_LEDGER_PATH, BUN_COMPAT_EXIT_FIRST);
		});

		test('the quarantined path exists and is discovered by the ci.yml find chain', () => {
			expect(existsSync(join(REPO_ROOT, BUN_COMPAT_EXIT_FIRST))).toBe(true);
		});
	});

	describe('repository-validation-real-process-2675.test.ts (already quarantined by issue #2738)', () => {
		test('is NOT duplicated into the general or windows ledgers by this PR', () => {
			// Issue #2730 listed this path, but it is already an active
			// entry in scripts/ci/quarantined-tests-macos.txt via
			// issue #2738 (commit ad8c53ae3, 2026-09-12). The
			// flake-detection script's Rule A drops already-quarantined
			// candidates, so re-listing it in another ledger would be a
			// silent no-op for detection but a confusing cross-ledger
			// duplicate for triage.
			expect(activeEntries(GENERAL_LEDGER_PATH)).not.toContain(
				REPO_VALIDATION_REAL_PROCESS_2675,
			);
			expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(
				REPO_VALIDATION_REAL_PROCESS_2675,
			);
		});

		test('remains in the macOS ledger exactly once (carried over from issue #2738)', () => {
			// Sanity check: the existing macOS-ledger entry survives this
			// PR's edit, and no duplicate block was added for it.
			const entries = activeEntries(MACOS_LEDGER_PATH);
			expect(entries).toContain(REPO_VALIDATION_REAL_PROCESS_2675);
			expect(
				entries.filter((e) => e === REPO_VALIDATION_REAL_PROCESS_2675).length,
			).toBe(1);
		});
	});
});
