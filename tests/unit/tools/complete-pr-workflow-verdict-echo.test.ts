import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { assertPrReviewValidationSettled } from '../../../src/hooks/pr-workflow-gate.js';
import { _internals } from '../../../src/tools/complete-pr-workflow.js';
import {
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';
import { establishDeadReviewerWorld } from '../pr-review/n-of-m-verdict-settlement.fixtures.js';

// Review PRR-005: the observation-only verdict_settlement echo in the
// completion report — a read failure must degrade to an absent echo (never
// fail the report), and a settled run must surface its per-item rows.

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

describe('verdict settlement report echo (issue #3101, review PRR-005)', () => {
	test('a settled run echoes its per-item disclosure rows', async () => {
		await establishDeadReviewerWorld();
		await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
		const rows = await _internals.verdictSettlementSummaryForReportSafe(
			tempDir,
			SESSION_ID,
		);
		expect(Array.isArray(rows)).toBe(true);
		expect(rows?.length).toBeGreaterThan(0);
		for (const row of rows ?? []) {
			expect(row.disposition).toBe('liveness_dead');
			expect(row.evidenceClass).toBe('liveness');
		}
	});

	test('a read failure degrades to an absent echo instead of failing the report', async () => {
		// No gate state exists in an empty directory: the underlying bound-state
		// read throws, and the safe wrapper must swallow it (observation-only).
		const rows = await _internals.verdictSettlementSummaryForReportSafe(
			tempDir,
			'no-such-session',
		);
		expect(rows).toBeUndefined();
	});
});
