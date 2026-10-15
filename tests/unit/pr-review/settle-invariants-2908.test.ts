/**
 * Settlement invariant properties (issue #2908, AC3) — fast-check, reducer layer.
 *
 * Four properties, >= 1000 cases each, per the census wedge-shape layer map in
 * docs/pr-review-transition-authority.md. The two LEDGER-layer disk properties
 * (#2214 claim interleavings, #2829 restart-fold across compaction) live in
 * sibling files under tests/unit/background/ — each runs 1000 real-store
 * interleavings in its own CI per-file budget:
 *   settle-claim-property-2214-2908.test.ts   (#2214 ledger layer)
 *   settle-restart-property-2829-2908.test.ts (#2829 ledger/checkpoint layer)
 *
 * Incident mapping held by this file's properties:
 *   #2402 / #2666 — a structured result whose generation differs from the
 *     active revision is always rejected stale_generation_result without
 *     mutating state (defense-in-depth behind the adapter/publisher/CAS
 *     fences, which the wedge reproductions exercise directly).
 *   #2840 — a disclosed coverage degradation can never finalize APPROVE, even
 *     on COMPLETE coverage.
 *   #2666 — a stale foreign-authorization armed-recovery binding is always
 *     rejected without mutating state.
 *   #2402 — no rejected transition ever mutates state, across random event
 *     sequences (the general no-advance invariant the incidents violate).
 */

import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { reducePrReviewEvent } from '../../../src/pr-review/reducer.js';
import type {
	PrReviewEvent,
	PrReviewWorkflowState,
} from '../../../src/pr-review/types.js';

const POLICY = {
	enabled: true,
	canaryProbeMs: 300_000,
	statusProbeTimeoutMs: 2_000,
	correlatedFailureThreshold: 2,
	maxRetryAttemptsAfterInitial: 2,
	circuitOpenDurationMs: 60_000,
};

function baseState(revision: number): PrReviewWorkflowState {
	return {
		sessionID: 'ses_2908',
		workflowInstanceId: 'wfi_2908',
		revision,
		prHeadSha: 'head',
		prReviewResilience: { policy: POLICY, attempts: [] },
	};
}

const EVENT_BUILDERS = {
	result: (generation: number, digest: string): PrReviewEvent => ({
		type: 'lane_structured_result_submitted',
		batchId: 'batch-1',
		laneId: 'lane-1',
		generation,
		semanticEnvelopeDigest: digest,
		outcome: 'FINDINGS',
	}),
	observed: (n: number): PrReviewEvent => ({
		type: 'collection_observed',
		diagnostic: n % 2 === 0 ? 'busy' : 'host_unavailable',
		pendingLaneIds: ['lane-1'],
	}),
	finalization: (
		kind: 'COMPLETE' | 'PARTIAL' | 'NO_COVERAGE',
		disclosed: boolean,
		verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'INCOMPLETE',
		liveCount: number,
	): PrReviewEvent => ({
		type: 'coverage_finalization_requested',
		settlement: {
			kind,
			coveredDimensions: [],
			unresolvedDimensions: [],
			liveDimensions: Array.from({ length: liveCount }, (_, i) => `dim-${i}`),
		},
		requestedVerdict: verdict,
		disclosedDegradation: disclosed,
	}),
};

describe('settlement invariant properties, reducer layer (issue #2908)', () => {
	test('#2402 #2666: a stale-generation result never advances state', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 6 }),
				fc.integer({ min: -4, max: 4 }),
				fc.string({ minLength: 1, maxLength: 12 }),
				(revision, generationDelta, digest) => {
					const state = baseState(revision);
					const event = EVENT_BUILDERS.result(
						revision + generationDelta,
						digest,
					);
					const result = reducePrReviewEvent(state, event);
					if (generationDelta !== 0) {
						expect(result.status).toBe('rejected');
						if (result.status === 'rejected') {
							expect(result.rejection.code).toBe('stale_generation_result');
							expect(result.state).toBe(state);
						}
						return;
					}
					if (result.status === 'rejected') {
						expect(result.rejection.code).not.toBe('stale_generation_result');
					}
				},
			),
			{ numRuns: 1000 },
		);
	});

	test('#2840: a disclosed degradation can never finalize APPROVE', () => {
		fc.assert(
			fc.property(
				fc.constantFrom('COMPLETE', 'PARTIAL', 'NO_COVERAGE'),
				fc.boolean(),
				fc.constantFrom('APPROVE', 'REQUEST_CHANGES', 'INCOMPLETE'),
				fc.integer({ min: 0, max: 2 }),
				(kind, disclosed, verdict, liveCount) => {
					const state = baseState(3);
					const event = EVENT_BUILDERS.finalization(
						kind,
						disclosed,
						verdict,
						liveCount,
					);
					const result = reducePrReviewEvent(state, event);
					const code =
						result.status === 'rejected' ? result.rejection.code : 'applied';
					// The #2840 incident pin: COMPLETE coverage plus a disclosed
					// degradation can never finalize APPROVE — by the degradation
					// code on a settled review, and never applied when live lanes
					// independently block.
					if (kind === 'COMPLETE' && disclosed && verdict === 'APPROVE') {
						expect(result.status).toBe('rejected');
						if (liveCount === 0) {
							expect(code).toBe('degraded_disclosure_cannot_approve');
						} else {
							expect(code).not.toBe('applied');
						}
						return;
					}
					// The pre-existing #2512 verdict matrix, exact on settled reviews.
					if (liveCount === 0) {
						if (kind === 'PARTIAL' && verdict === 'APPROVE') {
							expect(code).toBe('partial_coverage_cannot_approve');
						}
						if (kind === 'NO_COVERAGE' && verdict !== 'INCOMPLETE') {
							expect(code).toBe('no_coverage_requires_incomplete');
						}
					}
				},
			),
			{ numRuns: 1000 },
		);
	});

	test('#2666: a stale foreign-authorization recovery binding never advances state', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 5 }),
				fc.option(fc.string({ minLength: 1, maxLength: 8 }), {
					nil: undefined,
				}),
				(revision, reason) => {
					const state = baseState(revision);
					const event: PrReviewEvent = {
						type: 'armed_recovery_requested',
						binding: {
							sessionID: 'ses_2908',
							workflowInstanceId: 'wfi_OTHER',
							prHeadSha: 'head',
							generation: revision,
						},
						...(reason === undefined ? {} : { reason }),
					};
					const result = reducePrReviewEvent(state, event);
					expect(result.status).toBe('rejected');
					if (result.status === 'rejected') {
						expect(result.rejection.code).toBe('stale_foreign_authorization');
						expect(result.state).toBe(state);
					}
				},
			),
			{ numRuns: 1000 },
		);
	});

	test('#2402: no rejected transition ever mutates state across random sequences', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 4 }),
				fc.array(fc.integer({ min: 0, max: 9 }), {
					minLength: 4,
					maxLength: 24,
				}),
				(seedRevision, steps) => {
					let state = baseState(seedRevision);
					for (const step of steps) {
						const event: PrReviewEvent =
							step % 3 === 0
								? EVENT_BUILDERS.observed(step)
								: step % 3 === 1
									? EVENT_BUILDERS.result(
											state.revision + (step % 5) - 2,
											`digest-${step}`,
										)
									: EVENT_BUILDERS.finalization(
											['COMPLETE', 'PARTIAL', 'NO_COVERAGE'][step % 3] as
												| 'COMPLETE'
												| 'PARTIAL'
												| 'NO_COVERAGE',
											step % 2 === 0,
											['APPROVE', 'REQUEST_CHANGES', 'INCOMPLETE'][step % 3] as
												| 'APPROVE'
												| 'REQUEST_CHANGES'
												| 'INCOMPLETE',
											step % 3,
										);
						const result = reducePrReviewEvent(state, event);
						if (result.status === 'rejected') {
							expect(result.state).toBe(state);
						} else {
							state = result.state;
						}
					}
				},
			),
			{ numRuns: 1000 },
		);
	});
});
