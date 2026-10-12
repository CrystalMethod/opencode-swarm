// Issue #2906 — order-agreement composition semantics beyond the frozen C3
// pin: retry-within-order newest-wins, integrity-filtered continuation, and
// the vacuous single-item counterbalance.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports as gateInternals,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

const reviewedRow = (
	id: string,
	classification: string,
	severity: string,
): string =>
	`[REVIEWED] | ${id} | ${classification} | STRUCTURALLY_PROVEN | ${severity} | YES | file.ts:1 | rationale ${id} | probe ${id} | reviewer | ORDINARY | `;

async function declareReviewerBatch(
	batchId: string,
	reviewItemIds: readonly string[],
): Promise<void> {
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: `${batchId}-lane`,
				workflowLane: `${batchId}-lane`,
				reviewItemIds: [...reviewItemIds],
			},
		],
		{ batchId, prHeadSha: HEAD_SHA },
	);
}

async function persistReviewerBatch(
	batchId: string,
	rows: readonly string[],
): Promise<void> {
	await persistBatch(
		batchId,
		'swarm-pr-review:reviewer',
		[{ laneId: `${batchId}-lane`, workflowLane: `${batchId}-lane` }],
		{ textOverride: rows.join('\n'), subagentSessionId: `${batchId}-lane` },
	);
}

describe('order-agreement composition (issue #2906)', () => {
	test('retry within an order resolves to that order newest verdict', async () => {
		await establishReviewPrerequisites();
		// Batch 1 (A): C-1 CONFIRMED/HIGH. Batch 2 (B): C-1 CONFIRMED/HIGH.
		// Batch 3 (A again — ordinal distance 2): C-1 CONFIRMED/MEDIUM.
		// Newest per order: A=(CONFIRMED,MEDIUM), B=(CONFIRMED,HIGH) ⇒ disagree,
		// and the winning claim is batch 3's MEDIUM.
		await declareReviewerBatch('oa-a1', ['C-1']);
		await persistReviewerBatch('oa-a1', [
			reviewedRow('C-1', 'CONFIRMED', 'HIGH'),
		]);
		await declareReviewerBatch('oa-b1', ['C-1']);
		await persistReviewerBatch('oa-b1', [
			reviewedRow('C-1', 'CONFIRMED', 'HIGH'),
		]);
		await declareReviewerBatch('oa-a2', ['C-1']);
		await persistReviewerBatch('oa-a2', [
			reviewedRow('C-1', 'CONFIRMED', 'MEDIUM'),
		]);
		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		const claim = composed.claims.get('C-1');
		expect(claim?.classification).toBe('CONFIRMED');
		expect(claim?.severity).toBe('MEDIUM');
		expect(claim?.batchId).toBe('oa-a2');
		expect(claim?.orderAgreement).toBe('disagree');
	});

	test('a batch whose lanes never persisted contributes no observations', async () => {
		await establishReviewPrerequisites();
		// Declared-but-never-persisted batch C (would flip C-1 to DISPROVED if
		// wrongly counted); its artifact is absent so the continuation's
		// integrity gating must exclude it entirely.
		await declareReviewerBatch('oa-stale', ['C-1']);
		await declareReviewerBatch('oa-live-a', ['C-1']);
		await persistReviewerBatch('oa-live-a', [
			reviewedRow('C-1', 'CONFIRMED', 'HIGH'),
		]);
		await declareReviewerBatch('oa-live-b', ['C-1']);
		await persistReviewerBatch('oa-live-b', [
			reviewedRow('C-1', 'CONFIRMED', 'HIGH'),
		]);
		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		// The winning claim comes from the newest live batch; the stale batch's
		// unparseable state neither claims nor observes.
		expect(composed.claims.get('C-1')?.orderAgreement).toBe('agree');
	});

	test('vacuous single-item counterbalance: labels stay computed and descriptive', async () => {
		await establishReviewPrerequisites();
		await declareReviewerBatch('oa-single-a', ['C-1']);
		await persistReviewerBatch('oa-single-a', [
			reviewedRow('C-1', 'CONFIRMED', 'HIGH'),
		]);
		await declareReviewerBatch('oa-single-b', ['C-1']);
		await persistReviewerBatch('oa-single-b', [
			reviewedRow('C-1', 'CONFIRMED', 'HIGH'),
		]);
		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		// A and B render identical one-element sequences; the label is still
		// computed (agree) but cannot implicate order effects at n=1.
		expect(composed.claims.get('C-1')?.orderAgreement).toBe('agree');
	});

	test('a batch whose lanes never persisted contributes no observations', async () => {
		await establishReviewPrerequisites();
		// Declared-but-never-persisted batch C (would flip C-1 to DISPROVED if
		// wrongly counted); its artifact is absent so the continuation's
		// integrity gating must exclude it entirely.
		await declareReviewerBatch('oa-stale', ['C-1']);
		await declareReviewerBatch('oa-live-a', ['C-1']);
		await persistReviewerBatch('oa-live-a', [
			reviewedRow('C-1', 'CONFIRMED', 'HIGH'),
		]);
		await declareReviewerBatch('oa-live-b', ['C-1']);
		await persistReviewerBatch('oa-live-b', [
			reviewedRow('C-1', 'CONFIRMED', 'HIGH'),
		]);
		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		// The winning claim comes from the newest live batch; the stale batch's
		// unparseable state neither claims nor observes.
		expect(composed.claims.get('C-1')?.orderAgreement).toBe('agree');
	});

	test('vacuous single-item counterbalance: labels stay computed and descriptive', async () => {
		await establishReviewPrerequisites();
		await declareReviewerBatch('oa-single-a', ['C-1']);
		await persistReviewerBatch('oa-single-a', [
			reviewedRow('C-1', 'CONFIRMED', 'HIGH'),
		]);
		await declareReviewerBatch('oa-single-b', ['C-1']);
		await persistReviewerBatch('oa-single-b', [
			reviewedRow('C-1', 'CONFIRMED', 'HIGH'),
		]);
		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		// A and B render identical one-element sequences; the label is still
		// computed (agree) but cannot implicate order effects at n=1.
		expect(composed.claims.get('C-1')?.orderAgreement).toBe('agree');
	});

	// Unmarked-legacy labeling rule-out (plan D7 item 3, disclosed): a
	// post-#2906 reviewer batch CANNOT legitimately lack its coherence
	// presentationOrder — recordPrReviewValidationBatch stamps every reviewer
	// batch. Hand-stripping the persisted state desyncs the atomic-write
	// coordination manifest (verified empirically: composition then admits no
	// claims), and pre-#2906 persisted states predate the field entirely, so
	// every item in their windows labels 'single' — the pinned behavior above
	// and in C-3's single-coverage arm. The gating itself is visible at
	// src/pr-review/legacy-transcript-adapter.ts recordOrderObservations
	// (no-op when coherence.presentationOrder is undefined) and the schema's
	// tolerance for marker-less records is pinned by C-2.
});
