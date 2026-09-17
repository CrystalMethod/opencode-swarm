import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Repo root is four levels up from tests/unit/scripts/ci/.
const REPO_ROOT = join(import.meta.dir, '../../../..');
const WINDOWS_LEDGER_PATH = join(
	REPO_ROOT,
	'scripts/ci/quarantined-tests-windows.txt',
);
const GENERAL_LEDGER_PATH = join(REPO_ROOT, 'scripts/ci/quarantined-tests.txt');
const MACOS_LEDGER_PATH = join(
	REPO_ROOT,
	'scripts/ci/quarantined-tests-macos.txt',
);
const INTEGRATION_LEDGER_PATH = join(
	REPO_ROOT,
	'scripts/ci/quarantined-integration-tests.txt',
);

// Three paths quarantined by THIS PR for issue #2812. Of the six #2812
// candidates auto-filed by the merge-group flake-detection workflow (#1782)
// after CI run 35113965170 (merge_group pr-2765, head 16f82fcec19271f6,
// 2026-09-16T15:14:18Z), three were already on the windows ledger from
// PR #2774 (pr-subscriptions-checkpoint.test.ts and
// recall-evaluation-profile-isolation.test.ts) or routed to the general
// ledger by PR #2811's CORE-TREE placement
// (pr-workflow-gate-batch-gc.test.ts, tests/unit/hooks/** per detector
// rule C). This PR adds the remaining three as net-new windows-ledger
// entries because all three were single-OS windows-latest flakes with
// green ubuntu 1..6 / macos 1..6 siblings in the same CI run, which the
// windows-ledger re-add policy in scripts/ci/quarantined-tests-windows.txt
// routes to the windows ledger.
//
// Wrapped in object literals so `test.each`'s `$path` template interpolates
// the actual path into each test title (a primitive-string table renders
// the literal `$path` string for every iteration, masking which path
// failed; sibling pinning tests like ci-yml-quarantine-2740.test.ts and
// ci-yml-quarantine-2761.test.ts use the same destructured object form).
const ISSUE_2812_THIS_PR_QUARANTINED_PATHS: ReadonlyArray<{ path: string }> = [
	{ path: 'tests/unit/commands/archive.test.ts' },
	{ path: 'tests/unit/mcp/write-receipts-feedback-2500.test.ts' },
	{ path: 'tests/unit/tools/phase-complete.lock-adversarial.test.ts' },
];

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

describe('ci.yml integration — windows quarantine ledger entries for issue #2812 (this PR)', () => {
	test.each(
		ISSUE_2812_THIS_PR_QUARANTINED_PATHS,
	)('$path is an active entry in the windows ledger', ({ path }) => {
		// Regression guard for the three net-new #2812 entries added by this
		// PR: without them, the windows-latest unit shards would keep
		// flaking on these files and Rule A would re-file duplicate issues
		// on every detection (it only drops candidates already present in
		// a ledger).
		expect(existsSync(WINDOWS_LEDGER_PATH)).toBe(true);
		expect(activeEntries(WINDOWS_LEDGER_PATH)).toContain(path);
	});

	test.each(
		ISSUE_2812_THIS_PR_QUARANTINED_PATHS,
	)('$path is scoped to the windows ledger only (no cross-ledger duplicate)', ({
		path,
	}) => {
		// Cross-ledger duplicates would falsely imply cross-OS or
		// integration evidence: every #2812 candidate was single-detection
		// on windows-latest with green ubuntu/macos siblings, so the
		// entries must NOT suppress the files on other OSes. The general
		// ledger applies on every RUNNER_OS, the macOS ledger on macOS
		// runners, and the integration ledger for the `integration` job.
		for (const ledger of [
			GENERAL_LEDGER_PATH,
			MACOS_LEDGER_PATH,
			INTEGRATION_LEDGER_PATH,
		]) {
			expect(activeEntries(ledger)).not.toContain(path);
		}
	});

	test.each(
		ISSUE_2812_THIS_PR_QUARANTINED_PATHS,
	)('$path exists on disk and is discovered by the ci.yml find chain', ({
		path,
	}) => {
		// A typo'd ledger path would be a silent no-op: CI's comm -23
		// gated set would never exclude it (the path never appears in
		// all-tests.txt) and the flake-detection workflow would keep
		// re-filing. The unit discovery chain globs
		// tests/unit/**/*.test.ts, so the on-disk file must exist at
		// exactly the ledger path relative to the repo root.
		expect(existsSync(join(REPO_ROOT, path))).toBe(true);
	});

	test('windows ledger STATUS header count matches its active-entry count', () => {
		// The windows ledger's re-add policy tracks its active entry count in
		// a "# STATUS: N active entr(y|ies)" header line. Drift between the
		// declared count and the actual active-entry count (e.g. an entry
		// removed without updating the header, or a count bumped without the
		// matching entries) makes the header lie to triage. Note: this only
		// catches count drift; the presence tests above are the cross-PR
		// overwrite guard. Post-#2812 count is 9 (6 pre-existing on main
		// from PRs #2774/#2811 + 3 net-new from this PR).
		const raw = readFileSync(WINDOWS_LEDGER_PATH, 'utf8').replace(
			/\r\n/g,
			'\n',
		);
		const statusMatches = [
			...raw.matchAll(/^#\s*STATUS:\s*(\d+)\s+active entr/gm),
		];
		expect(statusMatches.length).toBe(1);
		const declared = Number(statusMatches[0]?.[1]);
		expect(declared).toBe(activeEntries(WINDOWS_LEDGER_PATH).length);
	});
});
