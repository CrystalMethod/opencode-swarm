import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	assertPrReviewValidationSettled,
	readPrReviewVerdictSettlementReceiptItems,
	recordPrReviewValidationBatch,
	resolvePrReviewWriterRunId,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	deriveVerdictSettlementAdmission,
	PR_REVIEW_VERDICT_RETRY_BUDGET,
} from '../../../src/pr-review/verdict-settlement.js';
import {
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';
import {
	DEAD_LANE,
	establishDeadReviewerWorld,
	establishFullInventory,
	reviewedRows,
	seedLivenessDeadLane,
} from './n-of-m-verdict-settlement.fixtures.js';

// Issue #3101 acceptance check C4 (frozen -t filter: "per-item disclosure"),
// plus the real budget-arm admission unit the original tautological
// `window: []` test only pretended to cover (review PRR-011).

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

describe('issue #3101 N-of-M verdict settlement', () => {
	describe('per-item disclosure', () => {
		test('per-item disclosure receipt carries lane, disposition, and evidence class for exactly the dead set', async () => {
			const { deadItems } = await establishDeadReviewerWorld();
			await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
			const items = await readPrReviewVerdictSettlementReceiptItems(
				tempDir,
				SESSION_ID,
			);
			const reviewerItems = items.filter(
				(item) => item.disposition === 'liveness_dead',
			);
			expect(reviewerItems.map((item) => item.itemId).sort()).toEqual(
				[...deadItems].sort(),
			);
			for (const item of reviewerItems) {
				expect(item.disposition).toBe('liveness_dead');
				expect(item.evidenceClass).toBe('liveness');
				expect(item.terminalStatus).toBe('stale');
				expect(item.sourceBatchId.startsWith('n-of-m-batch')).toBe(true);
				expect(item.sourceLaneId).toBe(DEAD_LANE);
			}
			// Idempotent: returns the already-reserved run id.
			const runId = await resolvePrReviewWriterRunId(tempDir, SESSION_ID);
			expect(runId).not.toBe('');
			const receiptPath = join(
				tempDir,
				'.swarm',
				'pr-review',
				runId,
				'verdict-settlement.reviewer.json',
			);
			expect(existsSync(receiptPath)).toBe(true);
			const raw = JSON.parse(readFileSync(receiptPath, 'utf-8')) as {
				phase: string;
				prHeadSha: string;
			};
			expect(raw.phase).toBe('reviewer');
			expect(raw.prHeadSha).toBe(HEAD_SHA);
		});

		test('per-item disclosure budget arithmetic mirrors the micro-family budget', () => {
			expect(PR_REVIEW_VERDICT_RETRY_BUDGET).toBe(2);
		});

		test('budget arm is per item: two liveness-dead attempts for an item refuse at the arm (not the empty-owner branch)', async () => {
			// Review PRR-011: the replaced test passed `window: []` and exited at
			// the empty-owner branch before ever reaching the budget arm. This
			// test drives the arm directly: two batches own the item with
			// controller-written liveness evidence, and 2 < 1 + budget must
			// refuse with the item-scoped budget reason.
			const admission = await (async () => {
				const ids = await establishFullInventory();
				const live = ids.slice(0, Math.max(1, Math.floor(ids.length / 2)));
				const dead = ids.slice(live.length);
				const window: Array<{
					batchId: string;
					lanes: Array<{
						laneId: string;
						workflowLane: string;
						reviewItemIds?: string[];
					}>;
				}> = [];
				for (const suffix of ['1', '2']) {
					const batchId = `unit-budget-batch-${suffix}`;
					await recordPrReviewValidationBatch(
						tempDir,
						SESSION_ID,
						'reviewer',
						[
							{
								laneId: 'n-of-m-live',
								workflowLane: 'n-of-m-live',
								reviewItemIds: live,
							},
							{
								laneId: DEAD_LANE,
								workflowLane: DEAD_LANE,
								reviewItemIds: dead,
							},
						],
						{ batchId, prHeadSha: HEAD_SHA },
					);
					if (suffix === '1') {
						await persistBatch(
							batchId,
							'swarm-pr-review:reviewer',
							[{ laneId: 'n-of-m-live', workflowLane: 'n-of-m-live' }],
							{ textOverride: reviewedRows(live) },
						);
					}
					await seedLivenessDeadLane({
						batchId,
						laneId: DEAD_LANE,
						phase: 'reviewer',
					});
					window.push({
						batchId,
						lanes: [
							{
								laneId: 'n-of-m-live',
								workflowLane: 'n-of-m-live',
								reviewItemIds: live,
							},
							{
								laneId: DEAD_LANE,
								workflowLane: DEAD_LANE,
								reviewItemIds: dead,
							},
						],
					});
				}
				return deriveVerdictSettlementAdmission({
					directory: tempDir,
					prHeadSha: HEAD_SHA,
					phase: 'reviewer',
					window,
					unclaimed: dead,
				});
			})();
			expect(admission.admitted).toBe(false);
			expect(admission.reason).toMatch(
				/verdict retry budget not exhausted \(2 of 3 required attempts\)/,
			);
			expect(admission.reason).toMatch(/item /);
		});
	});
});
