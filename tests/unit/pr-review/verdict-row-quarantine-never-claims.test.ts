/**
 * Issue #3310 AC3 — quarantine never fabricates a claim.
 *
 * An assigned item whose ONLY [REVIEWED] row has illegal arity must stay
 * unsettled: the row is a per-item contract failure, and quarantining it must
 * never create a claim for an id whose only row was quarantined.
 *
 * GREEN at base (PRESERVING); must remain green after the fix.
 */

import {
	analyzePrReviewVerdictRowContract,
	parsePrReviewVerdictRows,
} from '../../../src/pr-review/legacy-transcript-adapter.js';

describe('issue #3310 AC3: quarantine never claims an item whose only row was quarantined', () => {
	test('assigned id with only an illegal-arity row stays unclaimed and fails the contract', () => {
		// 8 pipe-separated fields — the legal reviewer arity is 12 (after
		// legacy-10 normalization), so this row can never yield a claim.
		const artifact =
			'[REVIEWED] | C-1 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | a.ts:1 | r';
		const analysis = analyzePrReviewVerdictRowContract(
			artifact,
			['C-1'],
			'reviewer',
		);

		expect(analysis.ok).toBe(false);
		const actual = JSON.parse(analysis.actual) as {
			invalidOrMissingIds: string[];
		};
		expect(actual.invalidOrMissingIds).toContain('C-1');
		const { parsed } = parsePrReviewVerdictRows(artifact, ['C-1'], 'reviewer');
		expect(parsed.has('C-1')).toBe(false);
	});
});
