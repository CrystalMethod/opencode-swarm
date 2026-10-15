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
 * Every generator cell asserts its EXACT expected outcome (rejection code or
 * applied status) against the reducer's published decision table — not only
 * the incident cells. No-mutation assertions are STRUCTURAL: each input state
 * is deep-frozen and JSON-snapshotted before reducing, so an in-place mutation
 * either throws on the frozen object or drifts the snapshot. A plain
 * `expect(result.state).toBe(state)` proves nothing here — the `rejected()`
 * helper returns the caller's reference.
 *
 * Incident mapping held by this file's properties:
 *   #2402 / #2666 — a structured result whose generation differs from the
 *     active revision is always rejected stale_generation_result without
 *     mutating state (defense-in-depth behind the adapter/publisher/CAS
 *     fences, which the wedge reproductions exercise directly); a
 *     matching-generation result settles through the exactly-once digest
 *     fence (semantic replay admitted, conflicting duplicate refused).
 *   #2840 — the full coverage-finalization decision table, cell by cell: a
 *     disclosed degradation can never finalize APPROVE even on COMPLETE
 *     coverage, and a live lane blocks coverage outright.
 *   #2666 — a stale foreign-authorization armed-recovery binding is always
 *     rejected without mutating state, independently across all four binding
 *     dimensions (session, workflow instance, head, generation); an
 *     authorized binding persists the operator's reason verbatim.
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

/**
 * Recursively freeze a state so an in-place mutation inside the reducer throws
 * (ES modules are strict mode) instead of silently corrupting the input.
 */
function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === 'object') {
		if (Array.isArray(value)) {
			for (const item of value) deepFreeze(item);
		} else {
			for (const key of Object.keys(value as Record<string, unknown>)) {
				deepFreeze((value as Record<string, unknown>)[key]);
			}
		}
		Object.freeze(value);
	}
	return value;
}

type FinalizationKind = 'COMPLETE' | 'PARTIAL' | 'NO_COVERAGE';
type FinalizationVerdict = 'APPROVE' | 'REQUEST_CHANGES' | 'INCOMPLETE';
type FinalizationOutcome =
	| 'live_lane_blocks_coverage'
	| 'partial_coverage_cannot_approve'
	| 'no_coverage_requires_incomplete'
	| 'degraded_disclosure_cannot_approve'
	| 'applied';

/**
 * The reducer's published coverage-finalization decision table, in precedence
 * order (src/pr-review/reducer.ts, `coverage_finalization_requested`): a live
 * lane blocks coverage BEFORE the verdict matrix runs, PARTIAL never approves,
 * NO_COVERAGE may only report INCOMPLETE, and a disclosed degradation on
 * COMPLETE coverage can never approve (#2840). Property 2 pins every cell.
 */
function expectedFinalizationOutcome(
	kind: FinalizationKind,
	disclosed: boolean,
	verdict: FinalizationVerdict,
	liveCount: number,
): FinalizationOutcome {
	if (liveCount > 0) return 'live_lane_blocks_coverage';
	if (kind === 'PARTIAL' && verdict === 'APPROVE') {
		return 'partial_coverage_cannot_approve';
	}
	if (kind === 'NO_COVERAGE' && verdict !== 'INCOMPLETE') {
		return 'no_coverage_requires_incomplete';
	}
	if (kind === 'COMPLETE' && disclosed && verdict === 'APPROVE') {
		return 'degraded_disclosure_cannot_approve';
	}
	return 'applied';
}

const EVENT_BUILDERS = {
	result: (
		generation: number,
		digest: string,
		existingDigest?: string,
	): PrReviewEvent => ({
		type: 'lane_structured_result_submitted',
		batchId: 'batch-1',
		laneId: 'lane-1',
		generation,
		semanticEnvelopeDigest: digest,
		outcome: 'FINDINGS',
		...(existingDigest === undefined
			? {}
			: { existingReceiptDigest: existingDigest }),
	}),
	observed: (n: number): PrReviewEvent => ({
		type: 'collection_observed',
		diagnostic: n % 2 === 0 ? 'busy' : 'host_unavailable',
		pendingLaneIds: ['lane-1'],
	}),
	finalization: (
		kind: FinalizationKind,
		disclosed: boolean,
		verdict: FinalizationVerdict,
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
	test('#2402 #2666: a stale-generation result never advances state; a matching one settles exactly once', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 6 }),
				fc.integer({ min: -4, max: 4 }),
				fc.string({ minLength: 1, maxLength: 12 }),
				fc.boolean(),
				fc.boolean(),
				(revision, generationDelta, digest, hasExisting, semanticReplay) => {
					const state = deepFreeze(baseState(revision));
					const snapshot = JSON.stringify(state);
					const existingDigest = hasExisting
						? semanticReplay
							? digest
							: `${digest}-conflicting`
						: undefined;
					const event = EVENT_BUILDERS.result(
						revision + generationDelta,
						digest,
						existingDigest,
					);
					const result = reducePrReviewEvent(state, event);
					// Structural no-mutation: the frozen input survived the reduce.
					expect(JSON.stringify(state)).toBe(snapshot);
					if (generationDelta !== 0) {
						// The stale-generation fence fires before the digest fence.
						expect(result.status).toBe('rejected');
						if (result.status === 'rejected') {
							expect(result.rejection.code).toBe('stale_generation_result');
							expect(result.state).toEqual(state);
						}
						return;
					}
					// Matching generation: the semanticEnvelopeDigest drives the
					// exactly-once fence, and every branch asserts.
					if (existingDigest === undefined) {
						expect(result.status).toBe('applied');
						if (result.status === 'applied') {
							expect(result.effects).toEqual([
								{
									kind: 'settle_delegation',
									batchId: 'batch-1',
									laneId: 'lane-1',
									status: 'completed',
								},
							]);
						}
						return;
					}
					if (existingDigest === digest) {
						// Exactly-once: a semantic replay re-settles the existing
						// receipt without another transition.
						expect(result.status).toBe('applied');
						if (result.status === 'applied') {
							expect(result.effects).toEqual([
								{
									kind: 'settle_delegation',
									batchId: 'batch-1',
									laneId: 'lane-1',
									status: 'completed',
									replay: true,
								},
							]);
						}
						return;
					}
					expect(result.status).toBe('rejected');
					if (result.status === 'rejected') {
						expect(result.rejection.code).toBe('duplicate_conflicting_result');
						expect(result.state).toEqual(state);
					}
				},
			),
			{ numRuns: 1000 },
		);
	});

	test('#2840: every finalization cell lands on its exact published outcome', () => {
		fc.assert(
			fc.property(
				fc.constantFrom('COMPLETE', 'PARTIAL', 'NO_COVERAGE'),
				fc.boolean(),
				fc.constantFrom('APPROVE', 'REQUEST_CHANGES', 'INCOMPLETE'),
				fc.integer({ min: 0, max: 2 }),
				(kind, disclosed, verdict, liveCount) => {
					const state = deepFreeze(baseState(3));
					const snapshot = JSON.stringify(state);
					const event = EVENT_BUILDERS.finalization(
						kind,
						disclosed,
						verdict,
						liveCount,
					);
					const result = reducePrReviewEvent(state, event);
					expect(JSON.stringify(state)).toBe(snapshot);
					const expected = expectedFinalizationOutcome(
						kind,
						disclosed,
						verdict,
						liveCount,
					);
					// EVERY cell asserts its exact outcome, which also pins the
					// live_lane_blocks_coverage guard on the blocking path: deleting
					// the guard moves every liveCount > 0 cell onto the verdict
					// matrix and fails here immediately.
					if (expected === 'applied') {
						expect(result.status).toBe('applied');
						if (result.status === 'applied') {
							// Finalization mutates no state; the completion adapter
							// persists at its own terminal clear.
							expect(result.state).toEqual(state);
							expect(result.effects).toEqual([]);
						}
						return;
					}
					expect(result.status).toBe('rejected');
					if (result.status === 'rejected') {
						expect(result.rejection.code).toBe(expected);
						expect(result.state).toEqual(state);
					}
				},
			),
			{ numRuns: 1000 },
		);
	});

	test('#2666: a stale foreign-authorization recovery binding never advances state; an authorized one persists the reason', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 5 }),
				// The four binding dimensions are generated INDEPENDENTLY, so a
				// generated cell can be foreign in session, workflow-instance,
				// head, or generation ALONE (or in any combination). The
				// production fences live in bindingRejection (src/pr-review/
				// reducer.ts): session, workflow-instance, head, generation —
				// one per dimension. When only workflowInstanceId was ever made
				// foreign, mutation-probes showed the property stayed GREEN with
				// any of the other three fences deleted; every cell still
				// asserts its EXACT outcome (applied iff all four dimensions
				// match, else rejected stale_foreign_authorization).
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				fc.string({ minLength: 1, maxLength: 8 }),
				(
					revision,
					sessionMatches,
					workflowInstanceMatches,
					headMatches,
					generationMatches,
					reason,
				) => {
					const state = deepFreeze(baseState(revision));
					const snapshot = JSON.stringify(state);
					const event: PrReviewEvent = {
						type: 'armed_recovery_requested',
						binding: {
							sessionID: sessionMatches ? 'ses_2908' : 'ses_FOREIGN',
							workflowInstanceId: workflowInstanceMatches
								? 'wfi_2908'
								: 'wfi_FOREIGN',
							prHeadSha: headMatches ? 'head' : 'head_FOREIGN',
							generation: generationMatches ? revision : revision + 3,
						},
						dimensionsToCancel: ['security-trust'],
						nowIso: '2026-01-01T00:00:00.000Z',
						reason,
					};
					const result = reducePrReviewEvent(state, event);
					expect(JSON.stringify(state)).toBe(snapshot);
					if (
						sessionMatches &&
						workflowInstanceMatches &&
						headMatches &&
						generationMatches
					) {
						// The applied arm makes the reason arbitrary load-bearing:
						// the recorded cancellation carries it verbatim.
						expect(result.status).toBe('applied');
						if (result.status === 'applied') {
							const cancellation =
								result.state.prReviewDimensionCancellations?.['security-trust'];
							expect(cancellation?.reason).toBe(reason);
							expect(cancellation?.cancelledAt).toBe(
								'2026-01-01T00:00:00.000Z',
							);
							expect(result.effects).toEqual([{ kind: 'persist_state' }]);
						}
						return;
					}
					expect(result.status).toBe('rejected');
					if (result.status === 'rejected') {
						expect(result.rejection.code).toBe('stale_foreign_authorization');
						expect(result.state).toEqual(state);
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
				fc.array(
					fc.record({
						// The event KIND is picked by `selector`; kind, verdict,
						// liveCount, disclosed and generationDelta are generated
						// independently so every combination stays reachable in the
						// finalization arm (not indexed by the arm selector).
						selector: fc.integer({ min: 0, max: 9 }),
						kind: fc.constantFrom('COMPLETE', 'PARTIAL', 'NO_COVERAGE'),
						verdict: fc.constantFrom(
							'APPROVE',
							'REQUEST_CHANGES',
							'INCOMPLETE',
						),
						liveCount: fc.integer({ min: 0, max: 2 }),
						disclosed: fc.boolean(),
						generationDelta: fc.integer({ min: -2, max: 2 }),
						digest: fc.string({ minLength: 1, maxLength: 8 }),
					}),
					{ minLength: 4, maxLength: 24 },
				),
				(seedRevision, steps) => {
					let state = deepFreeze(baseState(seedRevision));
					for (const step of steps) {
						const event: PrReviewEvent =
							step.selector % 3 === 0
								? EVENT_BUILDERS.observed(step.selector)
								: step.selector % 3 === 1
									? EVENT_BUILDERS.result(
											state.revision + step.generationDelta,
											step.digest,
										)
									: EVENT_BUILDERS.finalization(
											step.kind,
											step.disclosed,
											step.verdict,
											step.liveCount,
										);
						const snapshot = JSON.stringify(state);
						const result = reducePrReviewEvent(state, event);
						// Structural no-mutation on every step: the frozen input's
						// serialization is unchanged by the reduce, and a rejected
						// transition hands back exactly that serialization.
						expect(JSON.stringify(state)).toBe(snapshot);
						if (result.status === 'rejected') {
							expect(JSON.stringify(result.state)).toBe(snapshot);
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
