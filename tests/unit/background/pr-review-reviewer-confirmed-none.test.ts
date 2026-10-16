import { describe, expect, test } from 'bun:test';
import { PrReviewReviewerVerdictFieldsSchema } from '../../../src/background/pr-review-contract.js';
import { validateReviewerVerdictFields } from '../../../src/pr-review/legacy-transcript-adapter.js';

/**
 * Issue #3310 AC11 (reviewer lane quarantine — CONFIRMED/NONE grammar hole): a
 * CONFIRMED reviewer verdict carrying severity NONE is self-contradictory and
 * must fail the 12-field reviewer schema (naming the severity position or the
 * CONFIRMED classification), and therefore fail the adapter. RED at base,
 * GREEN after the fix (the base superRefine only forces NONE for DISPROVED,
 * so a CONFIRMED/NONE row is schema-valid and admits today).
 */

const CONFIRMED_NONE_ROW = [
	'[REVIEWED]',
	'C-1',
	'CONFIRMED',
	'STATIC_TRACE_PROVEN',
	'NONE',
	'YES',
	'a.ts:1',
	'rationale long',
	'probe text',
	'notes',
	'UNKNOWN',
	'',
];

describe('reviewer CONFIRMED/NONE row fails the grammar (issue #3310 AC11)', () => {
	test('the reviewer schema rejects a CONFIRMED verdict with severity NONE', () => {
		const parsed =
			PrReviewReviewerVerdictFieldsSchema.safeParse(CONFIRMED_NONE_ROW);
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			const issues = parsed.error.issues;
			expect(
				issues.some(
					(issue) => issue.path.includes(4) || /CONFIRMED/i.test(issue.message),
				),
			).toBe(true);
		}
	});

	test('validateReviewerVerdictFields returns null for the CONFIRMED/NONE row', () => {
		expect(validateReviewerVerdictFields(CONFIRMED_NONE_ROW)).toBeNull();
	});
});
