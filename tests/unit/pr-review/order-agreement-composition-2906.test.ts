// Issue #2906 — order-agreement composition semantics beyond the frozen C3
// pin: retry-within-order newest-wins, integrity-filtered continuation, the
// vacuous single-item counterbalance, and classification-only flips.

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
	options: { status?: 'completed' | 'error' } = {},
): Promise<void> {
	await persistBatch(
		batchId,
		'swarm-pr-review:reviewer',
		[{ laneId: `${batchId}-lane`, workflowLane: `${batchId}-lane` }],
		{
			textOverride: rows.join('\n'),
			subagentSessionId: `${batchId}-lane`,
			status: options.status,
		},
	);
}

/**
 * The full candidate inventory of `establishReviewPrerequisites` (six base
 * candidates C-0..C-5, micro lanes all CLEAN). Declaring a batch over the FULL
 * inventory makes the main loop's early exit fire on the newest batch, so the
 * older batches are reachable ONLY through the #2906 agreement-only
 * continuation — the code under test.
 */
const INVENTORY = ['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5'];

const rowsFor = (classification: string, severity: string): string[] =>
	INVENTORY.map((id) => reviewedRow(id, classification, severity));

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

	// F-08(a): the arm must DISCRIMINATE the continuation's integrity gating.
	// The old shape (a declared batch whose lanes were never persisted) could
	// not go red under a gating removal: an unpersisted batch has no artifact
	// anywhere on disk, so even unguarded reads observe nothing from it. The
	// batch below IS persisted — its artifact carries parseable DISPROVED rows
	// that would flip every observation — but its delegation record settles in
	// the error state, so `recordsPassingBatchIntegrity` must reject it in the
	// continuation. Neutralizing that gating makes this arm red.
	test('an integrity-failing persisted batch contributes no order observation', async () => {
		await establishReviewPrerequisites();
		// Declaration order fixes the counterbalanced orders A,B,A,B. The bad
		// batch is the NEWEST order-A batch, and the main loop settles on the
		// newest batch overall (oa2-settle) — so the bad batch is reachable only
		// through the agreement-only continuation, and only there can its
		// DISPROVED rows poison the order-A observation slot (first-write-wins
		// per order, scanned newest-first).
		await declareReviewerBatch('oa2-good-a', INVENTORY);
		await persistReviewerBatch('oa2-good-a', rowsFor('CONFIRMED', 'HIGH'));
		await declareReviewerBatch('oa2-good-b', INVENTORY);
		await persistReviewerBatch('oa2-good-b', rowsFor('CONFIRMED', 'HIGH'));
		await declareReviewerBatch('oa2-bad-a', INVENTORY);
		await persistReviewerBatch('oa2-bad-a', rowsFor('DISPROVED', 'NONE'), {
			status: 'error',
		});
		await declareReviewerBatch('oa2-settle', INVENTORY);
		await persistReviewerBatch('oa2-settle', rowsFor('CONFIRMED', 'HIGH'));
		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		const claim = composed.claims.get('C-0');
		expect(claim?.classification).toBe('CONFIRMED');
		expect(claim?.severity).toBe('HIGH');
		expect(claim?.orderAgreement).toBe('agree');
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

	// F-08(b): every earlier disagree fixture flipped severity only, so a
	// severity-only comparison survived. A classification flip at EQUAL severity
	// (CONFIRMED/HIGH vs UNVERIFIED/HIGH) is a disagreement that only the
	// classification comparison can see.
	test('a classification flip at equal severity labels disagree', async () => {
		await establishReviewPrerequisites();
		await declareReviewerBatch('clf-a', INVENTORY);
		await persistReviewerBatch('clf-a', rowsFor('CONFIRMED', 'HIGH'));
		await declareReviewerBatch('clf-b', INVENTORY);
		await persistReviewerBatch('clf-b', rowsFor('UNVERIFIED', 'HIGH'));
		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		const claim = composed.claims.get('C-0');
		// The newest pass (B) wins the claim; the label must still disagree.
		expect(claim?.classification).toBe('UNVERIFIED');
		expect(claim?.severity).toBe('HIGH');
		expect(claim?.orderAgreement).toBe('disagree');
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
