import { describe, expect, test } from 'bun:test';
import { PrReviewCriticVerdictFieldsSchema } from '../../../src/background/pr-review-contract.js';
import { validateCriticVerdictFields } from '../../../src/pr-review/legacy-transcript-adapter.js';

/**
 * Issue #3310 AC10 (UPHELD floor preservation): UPHELD stays rejected at NONE,
 * and the rank-equality (UPHELD == reviewer severity) and strictly-lower
 * (DOWNGRADED < reviewer severity) rules stay enforced. Green at base and
 * after the fix — these constraints are the floor the AC9 widening must keep.
 */

function criticRow(status: string, severity: string): string[] {
	return [
		'[CRITIC]',
		'c1',
		status,
		severity,
		'critic rationale long enough',
		'required change long enough',
	];
}

describe('critic UPHELD rank floor stays enforced (issue #3310 AC10)', () => {
	test('UPHELD at NONE against a NONE reviewer severity is rejected', () => {
		expect(
			validateCriticVerdictFields(criticRow('UPHELD', 'NONE'), 'NONE'),
		).toBeNull();
	});

	test('UPHELD at MEDIUM against a LOW reviewer severity is rejected (rank inequality)', () => {
		expect(
			validateCriticVerdictFields(criticRow('UPHELD', 'MEDIUM'), 'LOW'),
		).toBeNull();
	});

	test('UPHELD at HIGH against a MEDIUM reviewer severity is rejected', () => {
		expect(
			validateCriticVerdictFields(criticRow('UPHELD', 'HIGH'), 'MEDIUM'),
		).toBeNull();
	});

	test('DOWNGRADED at INFO against an INFO reviewer severity is rejected (not strictly lower)', () => {
		expect(
			validateCriticVerdictFields(criticRow('DOWNGRADED', 'INFO'), 'INFO'),
		).toBeNull();
	});

	test('UPHELD at CRITICAL against a HIGH reviewer severity is rejected', () => {
		expect(
			validateCriticVerdictFields(criticRow('UPHELD', 'CRITICAL'), 'HIGH'),
		).toBeNull();
	});

	test('the critic verdict schema rejects UPHELD at NONE regardless of reviewer severity', () => {
		expect(
			PrReviewCriticVerdictFieldsSchema.safeParse(criticRow('UPHELD', 'NONE'))
				.success,
		).toBe(false);
	});
});
