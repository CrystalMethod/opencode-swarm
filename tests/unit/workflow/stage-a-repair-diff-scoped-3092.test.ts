/**
 * Issue #3092 — hasGreenPostSettlementPreCheck consumer matrix for the
 * diff-scoped secretscan evidence fields. The #2918 vacuous arm is pinned in
 * stage-a-repair-vacuous-2918.test.ts and stays total-keyed; this sibling
 * pins the new-findings basis at the green arm: zero-new pass is green
 * repair proof, new>0 is not, and legacy evidence without the counter keeps
 * the pre-#3092 total-findings bar.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { saveEvidence } from '../../../src/evidence/manager';
import { hasGreenPostSettlementPreCheck } from '../../../src/workflow/stage-a-repair';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let directory: string;
let cleanup: () => void;

beforeEach(() => {
	({ dir: directory, cleanup } = createSafeTestDir('stage-a-3092'));
});

afterEach(() => {
	cleanup();
});

async function writeGreenSast(): Promise<void> {
	await saveEvidence(directory, 'sast_scan', {
		task_id: 'sast_scan',
		type: 'sast',
		// Literal fixture timestamp: inert (settledAfterMs=null skips the
		// staleness parse) and keeps check:test-clock clean.
		timestamp: '2026-10-06T12:00:00.000Z',
		agent: 'pre_check_batch',
		verdict: 'pass',
		summary: 'no findings',
		findings: [],
		engine: 'tier_a',
		files_scanned: 5,
		findings_count: 0,
		findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
	});
}

async function writeSecretscan(
	overrides: Record<string, unknown>,
): Promise<void> {
	await saveEvidence(directory, 'secretscan', {
		task_id: 'secretscan',
		type: 'secretscan',
		// Literal fixture timestamp (settledAfterMs=null never parses it).
		timestamp: '2026-10-06T12:00:00.000Z',
		agent: 'pre_check_batch',
		verdict: 'pass',
		summary:
			'Secretscan: 1 finding(s), 1 files scanned, 0 skipped, 0 new secret finding(s) on changed lines (1 pre-existing)',
		findings_count: 1,
		files_scanned: 1,
		skipped_files: 0,
		incomplete_files: 0,
		incomplete_paths: [],
		...overrides,
	});
}

describe('hasGreenPostSettlementPreCheck diff-scoped green basis (#3092)', () => {
	test('zero-new pass with one visible pre-existing finding is green repair proof', async () => {
		await writeSecretscan({
			new_findings_count: 0,
			preexisting_findings_count: 1,
			diff_scoped: true,
		});
		await writeGreenSast();
		const result = await hasGreenPostSettlementPreCheck(directory, null);
		expect(result).toEqual({ green: true });
	});

	test('new findings above zero are not green repair proof', async () => {
		await writeSecretscan({
			verdict: 'fail',
			findings_count: 2,
			new_findings_count: 2,
			preexisting_findings_count: 0,
			diff_scoped: true,
		});
		await writeGreenSast();
		const result = await hasGreenPostSettlementPreCheck(directory, null);
		expect(result).not.toEqual({ green: true });
	});

	test('inconsistent counters fall back to the total and are not green (PRR-010)', async () => {
		// findings 5 with new 0 + preexisting 0 is self-contradictory: a
		// forged zero-new counter must not launder five findings into a pass.
		await writeSecretscan({
			new_findings_count: 0,
			preexisting_findings_count: 0,
			diff_scoped: true,
		});
		await writeGreenSast();
		const result = await hasGreenPostSettlementPreCheck(directory, null);
		expect(result).not.toEqual({ green: true });
	});

	test('a non-integer counter forged into the persisted bundle stays not green', async () => {
		// The Zod evidence schema rejects a malformed counter at write time,
		// so the only realistic carrier is hand-forged evidence on disk; on
		// read the bundle fails schema validation and the entry is skipped —
		// not green either way.
		await writeSecretscan({
			new_findings_count: 0,
			preexisting_findings_count: 1,
			diff_scoped: true,
		});
		const bundle = path.join(
			directory,
			'.swarm',
			'evidence',
			'secretscan',
			'evidence.json',
		);
		const parsed = JSON.parse(fs.readFileSync(bundle, 'utf8')) as {
			entries: Array<Record<string, unknown>>;
		};
		const last = parsed.entries[parsed.entries.length - 1];
		last.new_findings_count = '0';
		delete last.preexisting_findings_count;
		fs.writeFileSync(bundle, JSON.stringify(parsed));
		await writeGreenSast();
		const result = await hasGreenPostSettlementPreCheck(directory, null);
		expect(result).not.toEqual({ green: true });
	});

	test('incomplete_paths with a zero-new basis stays not green (FB-008)', async () => {
		await writeSecretscan({
			new_findings_count: 0,
			preexisting_findings_count: 1,
			diff_scoped: true,
			incomplete_paths: [{ path: 'locked.ts', reason: 'read_error' }],
		});
		await writeGreenSast();
		const result = await hasGreenPostSettlementPreCheck(directory, null);
		expect(result).not.toEqual({ green: true });
	});

	test('legacy evidence without the counter falls back to the total (not green)', async () => {
		await writeSecretscan({});
		await writeGreenSast();
		const result = await hasGreenPostSettlementPreCheck(directory, null);
		expect(result).not.toEqual({ green: true });
	});

	test('a counter of exactly zero is honored, not treated as absent', async () => {
		// The truthiness trap: if the fallback used `||`, this evidence
		// (findings_count 1, new_findings_count 0) would fall back to 1 and
		// read not-green — wedging the repair loop this fix exists to free.
		await writeSecretscan({
			new_findings_count: 0,
			preexisting_findings_count: 1,
			diff_scoped: true,
		});
		await writeGreenSast();
		const result = await hasGreenPostSettlementPreCheck(directory, null);
		expect(result).toEqual({ green: true });
	});
});
