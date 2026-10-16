/**
 * Issue #3310 AC2 — critic verdict-row foreign-grammar quarantine.
 *
 * A critic artifact that carries a valid 6-field [CRITIC] row for the assigned
 * item must settle even when the same artifact also contains a stray
 * illegal-arity [CRITIC] row with an unassigned id. The stray row must be
 * quarantined into a diagnostics surface that still names its identifier,
 * never voiding the valid sibling row.
 *
 * RED at base, GREEN after the fix: at base every marker line counts toward
 * the exact-set check, so the stray unassigned id makes ok=false with an
 * unexpectedIds signature; after the fix illegal-arity rows are quarantined
 * and the valid row settles.
 */

import {
	analyzePrReviewVerdictRowContract,
	type PrReviewItemClaim,
	parsePrReviewVerdictRows,
} from '../../../src/pr-review/legacy-transcript-adapter.js';

const CRITIC_ARTIFACT = [
	'[CRITIC] | C-1 | UPHELD | HIGH | rationale long enough | required change text',
	'[CRITIC] | task-unknown | UPHELD',
].join('\n');

const REVIEWER_CLAIMS: ReadonlyMap<string, PrReviewItemClaim> = new Map([
	[
		'C-1',
		{
			batchId: 'batch-1',
			laneId: 'lane-1',
			workflowLane: 'workflow-lane-1',
			classification: 'CONFIRMED',
			severity: 'HIGH',
		},
	],
]);

describe('issue #3310 AC2: critic verdict-row foreign-grammar quarantine', () => {
	test('stray illegal-arity critic row with an unassigned id is quarantined and C-1 settles', () => {
		const analysis = analyzePrReviewVerdictRowContract(
			CRITIC_ARTIFACT,
			['C-1'],
			'critic',
			REVIEWER_CLAIMS,
		);

		expect(analysis.ok).toBe(true);
		const { parsed } = parsePrReviewVerdictRows(
			CRITIC_ARTIFACT,
			['C-1'],
			'critic',
			REVIEWER_CLAIMS,
		);
		expect(parsed.has('C-1')).toBe(true);
		// The quarantined row's identifier stays observable somewhere in the
		// result's diagnostics surface: 'task-unknown' is not an assigned id,
		// so after the fix the only legitimate place it can appear is the
		// quarantine record.
		expect(JSON.stringify(analysis)).toContain('task-unknown');
	});
});
