import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { encodePrReviewWorkflowBinding } from '../../../src/background/pr-review-contract';
import {
	buildPrReviewTriggerReceiptV2,
	V2ReceiptSchemaForInvariants,
} from '../../../src/background/pr-review-trigger-contract';
import { PR_REVIEW_REQUIRED_MICRO_LANE_IDS } from '../../../src/hooks/pr-workflow-gate';
import { _internals as writerInternals } from '../../../src/tools/write-pr-review-trigger-eval';
import {
	buildReceipt,
	establishBoundReviewGate,
	RECEIPT_ONLY_TEXT,
	readDurableReceipt,
	receiptPath,
	recordLane,
	restoreFollowupFixtures,
	rows,
	tempRoot,
	writeTriggerEval,
	writeTriggerEvalWithRows,
} from './trigger-eval-receipt-coverage-followup-fixtures';

// Issue #3094 followup coverage (outside the frozen manifest on purpose — the
// frozen trigger-eval-receipt-coverage.test.ts sits at the FR-006 cap): the
// consolidated partial-crediting shape, transcript-quality-flag suppression on
// a credited family, cross-schema replay normalization for the additive
// receipt_covered_families field, and the writer response disclosure fields.
// Shared fixtures live in the sibling non-test module.

afterEach(() => {
	restoreFollowupFixtures();
});

describe('write_pr_review_trigger_eval receipt coverage followups (issue #3094)', () => {
	test('consolidated lane with partially credited envelope covers only the credited family', async () => {
		const root = tempRoot();
		const binding = await establishBoundReviewGate(root, {
			skipMicroIndexes: [0, 1],
		});
		const [family0, family1] = PR_REVIEW_REQUIRED_MICRO_LANE_IDS;
		const batchId = 'micro-consol';
		const laneId = 'sweep-followup';
		const correlationId = `${batchId}-${laneId}-session`;
		// One consolidated lane owning families 0 and 1; its envelope credits
		// family 0 and leaves family 1 unresolved.
		await recordLane(root, {
			batchId,
			laneId,
			workflowLane: family0,
			ownedWorkflowLanes: [family0, family1],
			mode: 'swarm-pr-review:micro',
			text: RECEIPT_ONLY_TEXT,
			jobId: encodePrReviewWorkflowBinding(binding.workflowInstanceId),
			workflowGeneration: binding.revision,
			receipt: buildReceipt({
				workflowInstanceId: binding.workflowInstanceId,
				workflowRevision: binding.revision,
				batchId,
				laneId,
				workflowLane: family0,
				ownedWorkflowLanes: [family0, family1],
				creditedLanes: [family0],
				unresolved: [
					{
						workflowLane: family1,
						reason: 'NOT_EXECUTED',
						detail: 'the envelope did not attest this family',
					},
				],
				headSha: 'abc123',
				childSessionId: correlationId,
			}),
		});
		const consolRows = rows();
		consolRows[0] = {
			...consolRows[0],
			source_batch_id: batchId,
			source_lane_id: laneId,
		};
		consolRows[1] = {
			...consolRows[1],
			source_batch_id: batchId,
			source_lane_id: laneId,
		};
		const result = JSON.parse(
			await writeTriggerEvalWithRows(
				root,
				'followup-consol-partial',
				consolRows,
			),
		);
		expect(result.success).toBe(true);
		const receipt = readDurableReceipt(root, 'followup-consol-partial');
		expect(receipt.receipt_covered_families).toEqual([
			{ trigger_id: family0, source_batch_id: batchId, source_lane_id: laneId },
		]);
		const family0Degraded = (receipt.coverage_degradations ?? []).some(
			(entry: { trigger_id: string }) => entry.trigger_id === family0,
		);
		expect(family0Degraded).toBe(false);
		const family1Uncovered = (receipt.coverage_degradations ?? []).filter(
			(entry: { trigger_id: string; reason: string }) =>
				entry.trigger_id === family1 &&
				entry.reason.includes('no covered candidate or clean row'),
		);
		expect(family1Uncovered.length).toBe(1);
	});

	test('credited family with transcript-quality flags records no degradation', async () => {
		const root = tempRoot();
		const binding = await establishBoundReviewGate(root, {
			skipMicroIndexes: [2],
		});
		const family = PR_REVIEW_REQUIRED_MICRO_LANE_IDS[2];
		const batchId = 'micro-batch-0';
		const laneId = 'lane-2';
		const correlationId = `${batchId}-${laneId}-session`;
		await recordLane(root, {
			batchId,
			laneId,
			workflowLane: family,
			mode: 'swarm-pr-review:micro',
			text: RECEIPT_ONLY_TEXT,
			jobId: encodePrReviewWorkflowBinding(binding.workflowInstanceId),
			workflowGeneration: binding.revision,
			receipt: buildReceipt({
				workflowInstanceId: binding.workflowInstanceId,
				workflowRevision: binding.revision,
				batchId,
				laneId,
				workflowLane: family,
				ownedWorkflowLanes: [family],
				creditedLanes: [family],
				unresolved: [],
				headSha: 'abc123',
				childSessionId: correlationId,
			}),
			// The transcript-quality flags describe the superseded channel; the
			// accepted envelope is the authoritative settlement (#3094 rule 4).
			resultOverrides: {
				truncated: true,
				outputDegraded: true,
				transcriptIncomplete: true,
			},
		});
		const result = JSON.parse(
			await writeTriggerEval(root, 'followup-quality-flags'),
		);
		expect(result.success).toBe(true);
		expect(result.coverage_degradation_count).toBe(0);
		const receipt = readDurableReceipt(root, 'followup-quality-flags');
		expect(receipt.coverage_degradations).toEqual([]);
		expect(receipt.receipt_covered_families.length).toBe(1);
	});

	test('pre-upgrade receipt without the disclosure field replays equal', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root, { skipMicroIndexes: [] });
		const first = JSON.parse(await writeTriggerEval(root, 'followup-replay'));
		expect(first.success).toBe(true);
		expect(first.replayed).toBe(false);
		// Simulate a receipt written before receipt_covered_families existed:
		// delete the materialized key from the durable artifact on disk.
		const onDisk = readDurableReceipt(root, 'followup-replay');
		delete onDisk.receipt_covered_families;
		writeFileSync(
			receiptPath(root, 'followup-replay'),
			`${JSON.stringify(onDisk, null, 2)}\n`,
			'utf-8',
		);
		expect(existsSync(receiptPath(root, 'followup-replay'))).toBe(true);
		const replay = JSON.parse(await writeTriggerEval(root, 'followup-replay'));
		expect(replay.success).toBe(true);
		expect(replay.replayed).toBe(true);
	});

	test('writer response discloses receipt-covered families', async () => {
		const root = tempRoot();
		const binding = await establishBoundReviewGate(root, {
			skipMicroIndexes: [4],
		});
		const family = PR_REVIEW_REQUIRED_MICRO_LANE_IDS[4];
		const batchId = 'micro-batch-0';
		const laneId = 'lane-4';
		const correlationId = `${batchId}-${laneId}-session`;
		await recordLane(root, {
			batchId,
			laneId,
			workflowLane: family,
			mode: 'swarm-pr-review:micro',
			text: RECEIPT_ONLY_TEXT,
			jobId: encodePrReviewWorkflowBinding(binding.workflowInstanceId),
			workflowGeneration: binding.revision,
			receipt: buildReceipt({
				workflowInstanceId: binding.workflowInstanceId,
				workflowRevision: binding.revision,
				batchId,
				laneId,
				workflowLane: family,
				ownedWorkflowLanes: [family],
				creditedLanes: [family],
				unresolved: [],
				headSha: 'abc123',
				childSessionId: correlationId,
			}),
		});
		const settled = JSON.parse(
			await writeTriggerEval(root, 'followup-response-settled'),
		);
		expect(settled.success).toBe(true);
		expect(settled.coverage_degradation_count).toBe(0);
		expect(settled.receipt_covered_family_count).toBe(1);
		expect(settled.receipt_covered_families).toEqual([
			{
				trigger_id: family,
				source_batch_id: batchId,
				source_lane_id: laneId,
			},
		]);
		expect(settled.receipt_covered_note).toContain('receipt-covered');
		const root2 = tempRoot('trigger-eval-receipt-followup-2-');
		await establishBoundReviewGate(root2, { skipMicroIndexes: [] });
		const textOnly = JSON.parse(
			await writeTriggerEval(root2, 'followup-response-text'),
		);
		expect(textOnly.success).toBe(true);
		expect(textOnly.receipt_covered_family_count).toBe(0);
		expect(textOnly.receipt_covered_note).toBeUndefined();
	});

	test('receipt landing between snapshot and credit decision still credits (F2 re-read)', async () => {
		const root = tempRoot();
		// Discrimination constraint (review round 1): the instrumented family
		// must be the FIRST row citing its batch, so its loop-top snapshot read
		// is batch-read #1 (receipt-free) and its credit block's fresh re-read
		// is batch-read #2 (receipt landed). Any later row's snapshot would
		// already carry the injected receipt and the test would pass without
		// the re-read fix (verified against parent 5e2e661e).
		const settledIndex = 0;
		const binding = await establishBoundReviewGate(root, {
			skipMicroIndexes: [settledIndex],
		});
		const family = PR_REVIEW_REQUIRED_MICRO_LANE_IDS[settledIndex];
		const batchId = 'micro-batch-0';
		const laneId = `lane-${settledIndex}`;
		const correlationId = `${batchId}-${laneId}-session`;
		// Record is identity-bound (jobId + generation) but carries NO receipt
		// yet — the receipt "lands" between the loop-top snapshot and the
		// credit block's fresh re-read, via a wrapped seam.
		await recordLane(root, {
			batchId,
			laneId,
			workflowLane: family,
			mode: 'swarm-pr-review:micro',
			text: RECEIPT_ONLY_TEXT,
			jobId: encodePrReviewWorkflowBinding(binding.workflowInstanceId),
			workflowGeneration: binding.revision,
		});
		const landedReceipt = buildReceipt({
			workflowInstanceId: binding.workflowInstanceId,
			workflowRevision: binding.revision,
			batchId,
			laneId,
			workflowLane: family,
			ownedWorkflowLanes: [family],
			creditedLanes: [family],
			unresolved: [],
			headSha: 'abc123',
			childSessionId: correlationId,
		});
		const realFind = writerInternals.findByBatchIdDetailed;
		let batchReads = 0;
		writerInternals.findByBatchIdDetailed = ((directory, batch, options) => {
			const read = realFind(directory, batch, options);
			if (batch !== batchId || read.status !== 'ok') return read;
			batchReads += 1;
			if (batchReads < 2) return read;
			// Batch-read #2 is this row's credit-block re-read (row 0 is the
			// first MATCHED row, so its snapshot consumed batch-read #1). The
			// receipt has landed on the record by then.
			return {
				...read,
				value: read.value.map((candidate) =>
					candidate.laneId === laneId
						? {
								...candidate,
								result: {
									...candidate.result,
									prReviewResultReceipt: landedReceipt,
								},
							}
						: candidate,
				),
			};
		}) as typeof writerInternals.findByBatchIdDetailed;
		try {
			const result = JSON.parse(
				await writeTriggerEval(root, 'followup-toctou-credit'),
			);
			expect(result.success).toBe(true);
			expect(result.coverage_degradation_count).toBe(0);
			const receipt = readDurableReceipt(root, 'followup-toctou-credit');
			expect(receipt.receipt_covered_families).toEqual([
				{
					trigger_id: family,
					source_batch_id: batchId,
					source_lane_id: laneId,
				},
			]);
			expect(receipt.coverage_degradations).toEqual([]);
		} finally {
			writerInternals.findByBatchIdDetailed = realFind;
		}
	});

	test('differing non-empty receipt_covered_families on disk conflicts on replay', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root, { skipMicroIndexes: [] });
		const first = JSON.parse(await writeTriggerEval(root, 'followup-conflict'));
		expect(first.success).toBe(true);
		const onDisk = readDurableReceipt(root, 'followup-conflict');
		onDisk.receipt_covered_families = [
			{
				trigger_id: PR_REVIEW_REQUIRED_MICRO_LANE_IDS[0],
				source_batch_id: 'forged-batch',
				source_lane_id: 'forged-lane',
			},
		];
		writeFileSync(
			receiptPath(root, 'followup-conflict'),
			`${JSON.stringify(onDisk, null, 2)}\n`,
			'utf-8',
		);
		const replay = JSON.parse(
			await writeTriggerEval(root, 'followup-conflict'),
		);
		expect(replay.success).toBe(false);
		expect(replay.message).toContain('conflicting content');
	});

	test('replay keeps the loop-computed disclosure count in the response', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root, { skipMicroIndexes: [] });
		const first = JSON.parse(
			await writeTriggerEval(root, 'followup-replay-count'),
		);
		expect(first.success).toBe(true);
		expect(first.receipt_covered_family_count).toBe(0);
		const onDisk = readDurableReceipt(root, 'followup-replay-count');
		delete onDisk.receipt_covered_families;
		writeFileSync(
			receiptPath(root, 'followup-replay-count'),
			`${JSON.stringify(onDisk, null, 2)}\n`,
			'utf-8',
		);
		const replay = JSON.parse(
			await writeTriggerEval(root, 'followup-replay-count'),
		);
		expect(replay.success).toBe(true);
		expect(replay.replayed).toBe(true);
		// The count is computed from the live store at decision time, not read
		// back from the adopted pre-upgrade artifact.
		expect(replay.receipt_covered_family_count).toBe(0);
	});

	test('comparableTriggerReceipt replay equality survives the schema boundary (G6 invariant)', () => {
		// Schema-derived pair (review rounds 1-2): the new shape comes from the
		// real builder; the pre-upgrade on-disk shape omits EVERY key the v2
		// schema materializes via `.default()` — enumerated by parsing a
		// minimal-supplied input against V2ReceiptSchema and diffing the output
		// keys against the supplied ones, so a future .default() receipt field
		// added ANYWHERE in the schema is automatically included in the omission
		// set. If such a field is added without extending
		// comparableTriggerReceipt's normalization, `built` materializes it,
		// `onDisk` lacks it, and this test fails regardless of field position.
		const suppliedMinimal = {
			schema_version: 2 as const,
			run_id: 'g6-probe',
			pr_head_sha: 'abc123',
			base_ref: 'origin/main',
			base_sha: 'def456',
			evaluated_at: '2026-10-08T00:00:00.000Z',
			dispatched_micro_lane_count: 1,
			trigger_count: 0,
			matched_count: 0,
			not_triggered_count: 0,
			no_match_count: 0,
			rows: [],
		};
		const parsed = V2ReceiptSchemaForInvariants.parse(suppliedMinimal);
		const defaultedKeys = Object.keys(parsed).filter(
			(key) => !(key in suppliedMinimal),
		);
		const built = buildPrReviewTriggerReceiptV2({
			run_id: 'g6-invariant',
			pr_head_sha: 'abc123',
			base_ref: 'origin/main',
			base_sha: 'def456',
			evaluated_at: '2026-10-08T00:00:00.000Z',
			dispatched_micro_lane_count: 11,
			rows: rows(),
			base_verification: 'live',
		});
		const onDisk = JSON.parse(JSON.stringify(built));
		for (const key of defaultedKeys) {
			delete (onDisk as Record<string, unknown>)[key];
		}
		const comparable = writerInternals.comparableTriggerReceipt as (
			receipt: unknown,
		) => string;
		// The defaulted set must be non-empty (guards the probe itself: if the
		// enumeration breaks, the test degrades to comparing built with itself).
		expect(defaultedKeys).toContain('receipt_covered_families');
		expect(comparable(onDisk)).toBe(comparable(built));
	});
});
