/**
 * Issue #3310 AC1 — reviewer verdict-row foreign-grammar quarantine.
 *
 * A reviewer artifact that carries a valid 12-field [REVIEWED] row for every
 * assigned item must settle even when the same artifact also contains a stray
 * illegal-arity [REVIEWED] row with an unassigned id (foreign grammar such as
 * `APPROVED`) plus plain prose lines. The stray row must be quarantined into a
 * diagnostics surface that still names its identifier, never voiding the valid
 * sibling rows.
 *
 * RED at base, GREEN after the fix: at base every marker line counts toward the
 * exact-set check, so the stray unassigned id makes ok=false with an
 * unexpectedIds signature; after the fix illegal-arity rows are quarantined
 * and the valid sibling rows settle.
 */

import {
	analyzePrReviewVerdictRowContract,
	type PrReviewItemClaim,
	parsePrReviewVerdictRows,
} from '../../../src/pr-review/legacy-transcript-adapter.js';

const REVIEWER_ARTIFACT = [
	'[REVIEWED] | c1 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | a.ts:1 | rationale long | probe text | notes | UNKNOWN |',
	'[REVIEWED] | c2 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | b.ts:2 | rationale long | probe text | notes | UNKNOWN |',
	'[REVIEWED] | task-unknown | APPROVED | looks fine',
	'Some plain prose line that is not a verdict row at all.',
].join('\n');

const REVIEWER_CLAIMS_FOR_C1: ReadonlyMap<string, PrReviewItemClaim> = new Map([
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

describe('issue #3310 AC1: reviewer verdict-row foreign-grammar quarantine', () => {
	test('stray illegal-arity row with an unassigned id is quarantined and valid sibling rows settle', () => {
		const analysis = analyzePrReviewVerdictRowContract(
			REVIEWER_ARTIFACT,
			['c1', 'c2'],
			'reviewer',
		);

		expect(analysis.ok).toBe(true);
		const { parsed } = parsePrReviewVerdictRows(
			REVIEWER_ARTIFACT,
			['c1', 'c2'],
			'reviewer',
		);
		expect(parsed.has('c1')).toBe(true);
		expect(parsed.has('c2')).toBe(true);
		// The quarantined row's identifier stays observable somewhere in the
		// result's diagnostics surface: 'task-unknown' is not an assigned id,
		// so after the fix the only legitimate place it can appear is the
		// quarantine record.
		expect(JSON.stringify(analysis)).toContain('task-unknown');
	});

	test('critic marker scan is unaffected by reviewer-marker strays and prose', () => {
		const criticArtifact = [
			'[CRITIC] | C-1 | UPHELD | HIGH | rationale long enough | required change text',
			'[REVIEWED] | task-unknown | APPROVED | looks fine',
			'Some plain prose line that is not a verdict row at all.',
		].join('\n');
		const analysis = analyzePrReviewVerdictRowContract(
			criticArtifact,
			['C-1'],
			'critic',
			REVIEWER_CLAIMS_FOR_C1,
		);

		expect(analysis.ok).toBe(true);
		const { parsed } = parsePrReviewVerdictRows(
			criticArtifact,
			['C-1'],
			'critic',
			REVIEWER_CLAIMS_FOR_C1,
		);
		expect(parsed.has('C-1')).toBe(true);
	});
});
