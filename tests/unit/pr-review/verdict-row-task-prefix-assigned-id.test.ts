/**
 * Issue #3310 AC5 — assigned `task-*`-prefixed item ids with valid rows settle.
 *
 * The quarantine lane keys on row arity, never on the shape of the assigned
 * id: a legal 12-field [REVIEWED] row for an assigned `task-7` id settles the
 * contract exactly like any other assigned id.
 *
 * GREEN at base (PRESERVING); must remain green after the fix.
 */

import {
	analyzePrReviewVerdictRowContract,
	parsePrReviewVerdictRows,
} from '../../../src/pr-review/legacy-transcript-adapter.js';

describe('issue #3310 AC5: task-prefixed assigned id settles with a valid row', () => {
	test("valid 12-field row for assigned 'task-7' settles the contract", () => {
		const artifact =
			'[REVIEWED] | task-7 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | a.ts:1 | rationale long | probe text | notes | UNKNOWN |';
		const analysis = analyzePrReviewVerdictRowContract(
			artifact,
			['task-7'],
			'reviewer',
		);

		expect(analysis.ok).toBe(true);
		const { parsed } = parsePrReviewVerdictRows(
			artifact,
			['task-7'],
			'reviewer',
		);
		expect(parsed.has('task-7')).toBe(true);
		expect(parsed.get('task-7')?.classification).toBe('CONFIRMED');
		expect(parsed.get('task-7')?.severity).toBe('HIGH');
	});
});
