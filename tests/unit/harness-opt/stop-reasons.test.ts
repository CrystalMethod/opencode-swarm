import { describe, expect, test } from 'bun:test';

/**
 * Stop-reason enum discipline (issue #2503, plan 6d): the frozen acceptance
 * check C5 matches /transient|budget|circuit/i against the reported stop
 * reason, so an `inconclusive` outcome must NEVER satisfy that regex — a
 * genuinely inconclusive round cannot masquerade as a budget/circuit stop —
 * while every exhaustion reason must.
 */
const EXHAUSTION_REASONS = [
	'transient_retry_budget_exhausted',
	'round_budget_exhausted',
	'wall_clock_budget_exhausted',
	'spend_budget_exhausted',
] as const;

const NON_BUDGET_REASONS = [
	'equivalent_patch_convergence',
	'digest_repeat',
	'integrity_failure',
	'heldout_consumed',
	'inconclusive',
	'completed',
	'stopped_by_operator',
] as const;

const C5_REGEX = /transient|budget|circuit/i;

describe('harness-opt stop-reason enum discipline', () => {
	test('every exhaustion reason satisfies the budget/circuit regex', () => {
		for (const reason of EXHAUSTION_REASONS) {
			expect(C5RegexMatches(reason), `${reason} should match`).toBe(true);
		}
	});

	test('no other reason satisfies the budget/circuit regex (inconclusive cannot masquerade)', () => {
		for (const reason of NON_BUDGET_REASONS) {
			expect(C5RegexMatches(reason), `${reason} should NOT match`).toBe(false);
		}
	});
});

function C5RegexMatches(reason: string): boolean {
	return C5_REGEX.test(reason);
}
