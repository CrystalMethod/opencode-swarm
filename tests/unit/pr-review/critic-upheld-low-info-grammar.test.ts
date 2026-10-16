import { describe, expect, test } from 'bun:test';
import { PrReviewCriticVerdictFieldsSchema } from '../../../src/background/pr-review-contract.js';
import { validateCriticVerdictFields } from '../../../src/pr-review/legacy-transcript-adapter.js';

/**
 * Issue #3310 AC9 (critic lane quarantine — UPHELD grammar floor): a critic
 * UPHELD verdict whose severity equals a LOW or INFO reviewer severity is a
 * rank-consistent confirmation and must validate through both the six-field
 * critic schema and validateCriticVerdictFields. RED at base, GREEN after the
 * fix (the base superRefine restricts UPHELD to CRITICAL/HIGH/MEDIUM, which
 * quarantines legitimate LOW/INFO confirmations).
 */

const UPHELD_LOW_ROW = [
	'[CRITIC]',
	'c1',
	'UPHELD',
	'LOW',
	'critic rationale long enough',
	'required change long enough',
];
const UPHELD_INFO_ROW = [
	'[CRITIC]',
	'c1',
	'UPHELD',
	'INFO',
	'critic rationale long enough',
	'required change long enough',
];

describe('critic UPHELD grammar admits LOW and INFO (issue #3310 AC9)', () => {
	test('UPHELD at LOW against a LOW reviewer severity validates end-to-end', () => {
		const verdict = validateCriticVerdictFields(UPHELD_LOW_ROW, 'LOW');
		expect(verdict).not.toBeNull();
		expect(verdict?.status).toBe('UPHELD');
		expect(verdict?.severity).toBe('LOW');
	});

	test('UPHELD at INFO against an INFO reviewer severity validates end-to-end', () => {
		const verdict = validateCriticVerdictFields(UPHELD_INFO_ROW, 'INFO');
		expect(verdict).not.toBeNull();
		expect(verdict?.status).toBe('UPHELD');
		expect(verdict?.severity).toBe('INFO');
	});

	test('the critic verdict schema itself accepts an UPHELD LOW row', () => {
		const parsed = PrReviewCriticVerdictFieldsSchema.safeParse(UPHELD_LOW_ROW);
		expect(parsed.success).toBe(true);
	});
});
