import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { saveEvidence } from '../../../src/evidence/manager';
import { hasGreenPostSettlementPreCheck } from '../../../src/workflow/stage-a-repair';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

/**
 * Issue #2918 — fourth enforcing site (hasGreenPostSettlementPreCheck,
 * src/workflow/stage-a-repair.ts). The other three sites (batch gate, hook
 * decoder, check-gate-status) are pinned in
 * tests/unit/tools/pre-check-docs-only-gate-2918.test.ts; these two tests pin
 * the repair-path arm so a refactor reverting the vacuous branch to a bare
 * `files_scanned > 0` bar goes red here instead of silently re-wedging
 * docs-only tasks at the repair path.
 */

let directory: string;
let cleanup: () => void;

beforeEach(() => {
	({ dir: directory, cleanup } = createSafeTestDir('stage-a-vacuous-2918'));
});

afterEach(() => {
	cleanup();
});

async function writeGreenSast(): Promise<void> {
	await saveEvidence(directory, 'sast_scan', {
		task_id: 'sast_scan',
		type: 'sast',
		// Literal fixture timestamp: inert for these tests (settledAfterMs=null
		// skips the staleness parse) and keeps check:test-clock clean.
		timestamp: '2026-09-24T12:00:00.000Z',
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

describe('hasGreenPostSettlementPreCheck vacuous coverage (#2918 site 4)', () => {
	test('vacuous secretscan evidence (policy-skipped docs-only batch) is green repair proof', async () => {
		await saveEvidence(directory, 'secretscan', {
			task_id: 'secretscan',
			type: 'secretscan',
			// Literal fixture timestamp: inert for these tests (they pass
			// settledAfterMs=null, so hasGreenPostSettlementPreCheck never
			// parses it) and keeps check:test-clock clean of raw clock reads.
			timestamp: '2026-09-24T12:00:00.000Z',
			agent: 'pre_check_batch',
			verdict: 'pass',
			summary: 'all 1 requested file(s) skipped by secretscan scan policy',
			findings_count: 0,
			files_scanned: 0,
			skipped_files: 1,
			policy_skipped_files: 1,
			requested_files: 1,
			incomplete_files: 0,
			incomplete_paths: [],
		});
		await writeGreenSast();
		const result = await hasGreenPostSettlementPreCheck(directory, null);
		expect(result).toEqual({ green: true });
	});

	test('legacy zero-scan secretscan evidence without the policy counters stays not green', async () => {
		await saveEvidence(directory, 'secretscan', {
			task_id: 'secretscan',
			type: 'secretscan',
			// Literal fixture timestamp: inert for these tests (they pass
			// settledAfterMs=null, so hasGreenPostSettlementPreCheck never
			// parses it) and keeps check:test-clock clean of raw clock reads.
			timestamp: '2026-09-24T12:00:00.000Z',
			agent: 'pre_check_batch',
			verdict: 'pass',
			summary: 'no secrets found',
			findings_count: 0,
			files_scanned: 0,
			skipped_files: 1,
			incomplete_files: 0,
			incomplete_paths: [],
		});
		await writeGreenSast();
		const result = await hasGreenPostSettlementPreCheck(directory, null);
		// Missing policy counters => non-vacuous => files_scanned 0 keeps the
		// strict pre-#2918 bar: no green secretscan bundle at all.
		expect(result).toEqual({ green: false, reason: 'no_pre_check_bundles' });
	});
});
