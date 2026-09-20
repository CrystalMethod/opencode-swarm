import { describe, expect, test } from 'bun:test';
import { PR_REVIEW_BASE_DIMENSION_IDS } from '../../../src/background/pr-review-contract.js';
import { prReviewReceiptHasCoverageDegradations } from '../../../src/background/pr-review-trigger-receipt-reader.js';
import { allowedPrReviewReportVerdicts } from '../../../src/pr-review/completion.js';
import { evaluateFinalFindingPolicy } from '../../../src/pr-review/finding-policy.js';
import { reducePrReviewEvent } from '../../../src/pr-review/reducer.js';
import type {
	PrReviewCoverageSettlementInput,
	PrReviewWorkflowState,
} from '../../../src/pr-review/types.js';

// Issue #2840: the trigger-eval receipt's disclosed coverage degradations
// (liveness-terminal dead family or coverage-quality) must reach the verdict
// matrix. A disclosed degradation makes the review DEGRADED_DISCLOSED —
// APPROVE is excluded — while the no-degradation matrix stays bit-identical.

const SESSION_ID = 'issue-2840-policy';
const HEAD = 'abc123';

function reducerState(): PrReviewWorkflowState {
	return { sessionID: SESSION_ID, revision: 1, prHeadSha: HEAD };
}

function completeSettlement(): PrReviewCoverageSettlementInput {
	return {
		kind: 'COMPLETE',
		coveredDimensions: PR_REVIEW_BASE_DIMENSION_IDS,
		unresolvedDimensions: [],
		liveDimensions: [],
	};
}

describe('issue #2840 — disclosed coverage degradation excludes APPROVE', () => {
	test('COMPLETE + disclosed degradation permits exactly [REQUEST_CHANGES, INCOMPLETE]', () => {
		expect([
			...allowedPrReviewReportVerdicts('COMPLETE', [], {
				disclosedCoverageDegradation: true,
			}),
		]).toEqual(['REQUEST_CHANGES', 'INCOMPLETE']);
	});

	test('COMPLETE + disclosed degradation with blocking findings stays [REQUEST_CHANGES, INCOMPLETE]', () => {
		const findings = [
			{
				id: 'F-1',
				severity: 'HIGH',
				action: 'fix',
				status: 'CONFIRMED',
			},
		];
		expect([
			...allowedPrReviewReportVerdicts('COMPLETE', findings, {
				disclosedCoverageDegradation: true,
			}),
		]).toEqual(['REQUEST_CHANGES', 'INCOMPLETE']);
	});

	test('PARTIAL + disclosed degradation stays [REQUEST_CHANGES, INCOMPLETE]', () => {
		expect([
			...allowedPrReviewReportVerdicts('PARTIAL', [], {
				disclosedCoverageDegradation: true,
			}),
		]).toEqual(['REQUEST_CHANGES', 'INCOMPLETE']);
	});

	test('NO_COVERAGE + disclosed degradation stays forced-INCOMPLETE', () => {
		expect([
			...allowedPrReviewReportVerdicts('NO_COVERAGE', [], {
				disclosedCoverageDegradation: true,
			}),
		]).toEqual(['INCOMPLETE']);
	});

	test('the production-constructed DEGRADED_DISCLOSED coverage maps through the finding policy without APPROVE', () => {
		const projection = evaluateFinalFindingPolicy({
			policyVersion: 1,
			finalStatus: 'COMPLETE',
			coverage: {
				kind: 'base',
				quality: 'degraded',
				disclosed: true,
				provenance: 'valid',
			},
			findings: [],
		});
		expect(projection.coverageDisposition).toBe('DEGRADED_DISCLOSED');
		expect(projection.permittedVerdicts).toEqual([
			'REQUEST_CHANGES',
			'INCOMPLETE',
		]);
	});

	test('reader-direct: unset receipt path reads as no degradation without touching the filesystem', () => {
		expect(
			prReviewReceiptHasCoverageDegradations(
				'E:/definitely-not-a-real-project-2840',
				undefined,
			),
		).toBe(false);
		expect(
			prReviewReceiptHasCoverageDegradations(
				'E:/definitely-not-a-real-project-2840',
				null,
			),
		).toBe(false);
		expect(
			prReviewReceiptHasCoverageDegradations(
				'E:/definitely-not-a-real-project-2840',
				'',
			),
		).toBe(false);
	});
});

describe('reducer — coverage_finalization_requested under disclosed degradation', () => {
	test('reducer rejects COMPLETE + APPROVE + disclosedDegradation as degraded_disclosure_cannot_approve', () => {
		const outcome = reducePrReviewEvent(reducerState(), {
			type: 'coverage_finalization_requested',
			settlement: completeSettlement(),
			requestedVerdict: 'APPROVE',
			disclosedDegradation: true,
		});
		expect(outcome.status).toBe('rejected');
		if (outcome.status === 'rejected') {
			expect(outcome.rejection.code).toBe('degraded_disclosure_cannot_approve');
			expect(outcome.rejection.detail).toContain('APPROVE');
		}
	});

	test('reducer applies COMPLETE + REQUEST_CHANGES + disclosedDegradation', () => {
		const outcome = reducePrReviewEvent(reducerState(), {
			type: 'coverage_finalization_requested',
			settlement: completeSettlement(),
			requestedVerdict: 'REQUEST_CHANGES',
			disclosedDegradation: true,
		});
		expect(outcome.status).toBe('applied');
	});

	test('reducer applies COMPLETE + INCOMPLETE + disclosedDegradation', () => {
		const outcome = reducePrReviewEvent(reducerState(), {
			type: 'coverage_finalization_requested',
			settlement: completeSettlement(),
			requestedVerdict: 'INCOMPLETE',
			disclosedDegradation: true,
		});
		expect(outcome.status).toBe('applied');
	});

	test('reducer parity: without the flag COMPLETE + APPROVE still applies (production matrix unchanged)', () => {
		const outcome = reducePrReviewEvent(reducerState(), {
			type: 'coverage_finalization_requested',
			settlement: completeSettlement(),
			requestedVerdict: 'APPROVE',
		});
		expect(outcome.status).toBe('applied');
	});

	test('reducer: disclosedDegradation:false behaves exactly like the omitted flag', () => {
		const outcome = reducePrReviewEvent(reducerState(), {
			type: 'coverage_finalization_requested',
			settlement: completeSettlement(),
			requestedVerdict: 'APPROVE',
			disclosedDegradation: false,
		});
		expect(outcome.status).toBe('applied');
	});
});

describe('no-degradation — the pre-#2840 matrix is unchanged', () => {
	test('no-degradation: COMPLETE without options permits exactly [APPROVE, REQUEST_CHANGES, INCOMPLETE]', () => {
		expect([...allowedPrReviewReportVerdicts('COMPLETE')]).toEqual([
			'APPROVE',
			'REQUEST_CHANGES',
			'INCOMPLETE',
		]);
	});

	test('no-degradation: COMPLETE with disclosedCoverageDegradation:false still permits APPROVE', () => {
		expect([
			...allowedPrReviewReportVerdicts('COMPLETE', [], {
				disclosedCoverageDegradation: false,
			}),
		]).toEqual(['APPROVE', 'REQUEST_CHANGES', 'INCOMPLETE']);
	});

	test('no-degradation: PARTIAL and NO_COVERAGE rows are unchanged', () => {
		expect([...allowedPrReviewReportVerdicts('PARTIAL')]).toEqual([
			'REQUEST_CHANGES',
			'INCOMPLETE',
		]);
		expect([...allowedPrReviewReportVerdicts('NO_COVERAGE')]).toEqual([
			'INCOMPLETE',
		]);
	});
});
