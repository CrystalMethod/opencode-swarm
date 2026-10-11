import { createHash } from 'node:crypto';
import {
	appendDelegationTransition,
	type BackgroundDelegationRecord,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

// Shared world-building helpers for the issue #3101 N-of-M verdict-settlement
// suites (split from the original 581-line file for the FR-006 cap). These
// helpers are lifecycle-free: every importing test file installs its own
// beforeEach/afterEach via setup/teardownPrWorkflowGateFixtures.

export const CANDIDATE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';

export const LIVE_LANE = 'n-of-m-live';
export const DEAD_LANE = 'n-of-m-dead';

export const reviewedRows = (ids: readonly string[]): string =>
	ids
		.map(
			(id) =>
				`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale ${id} | probe ${id} | reviewer | ORDINARY | `,
		)
		.join('\n');

export const criticisedRows = (ids: readonly string[]): string =>
	ids
		.map(
			(id) =>
				`[CRITIC] | ${id} | UPHELD | HIGH | reason ${id} | required change ${id}`,
		)
		.join('\n');

export interface SeedDeadLaneArgs {
	batchId: string;
	laneId: string;
	phase: 'reviewer' | 'critic';
	terminalStatus?: 'stale' | 'cancelled' | 'error';
	/**
	 * Omit the controller-written typed liveness class from the transition
	 * result (issue #3101 constraint 1: the lane's own error text, however
	 * liveness-shaped, is NOT terminality evidence — the class is).
	 */
	omitFailureClass?: boolean;
}

export async function seedLivenessDeadLane({
	batchId,
	laneId,
	phase,
	terminalStatus = 'stale',
	omitFailureClass = false,
}: SeedDeadLaneArgs): Promise<void> {
	const correlationId = `${batchId}-${laneId}-session`;
	const staleReason = `lane ${laneId} presumed stale: idle host session past the stale horizon`;
	await recordPendingDelegation(tempDir, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `${batchId}-${laneId}-call`,
		normalizedAgent: phase,
		swarmPrefixedAgent: phase,
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId,
		mode: `swarm-pr-review:${phase}`,
		prReviewLegacyTranscriptCompatibility: true,
		workflowLane: laneId,
		workspace: {
			directory: tempDir,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: 'complete PR diff def456...abc123',
		},
	});
	await appendDelegationTransition(tempDir, correlationId, {
		status: terminalStatus,
		result: {
			error: staleReason,
			chars: staleReason.length,
			truncated: false,
			digest: createHash('sha256').update(staleReason).digest('hex'),
			...(omitFailureClass
				? {}
				: { workflowLaneFailureClass: 'liveness' as const }),
		},
	});
}

/**
 * The full candidate inventory after the standard prerequisites (their own
 * base candidates plus this suite's six). Every declaration below partitions
 * ALL of it so no item is left ownerless by accident.
 */
export async function establishFullInventory(): Promise<string[]> {
	await establishReviewPrerequisites();
	const { PR_REVIEW_BASE_DIMENSION_IDS, enforcePrReviewBaseDimensions } =
		await import('../../../src/hooks/pr-workflow-gate.js');
	const [dimension] = PR_REVIEW_BASE_DIMENSION_IDS;
	const lane = { laneId: 'inv-lane', workflowLane: dimension };
	const ids = Array.from({ length: 6 }, (_v, i) => `I-${i + 1}`);
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, [lane], {
		batchId: 'inv-batch',
		prHeadSha: HEAD_SHA,
	});
	await persistBatch('inv-batch', 'swarm-pr-review:base', [lane], {
		textOverride: [
			CANDIDATE_HEADER,
			...ids.map(
				(id) =>
					`${id} | ${dimension} | HIGH | correctness | file.ts:1 | claim ${id} | evidence ${id} | impact ${id} | HIGH | ORDINARY | `,
			),
		].join('\n'),
	});
	const { _test_exports } = await import(
		'../../../src/hooks/pr-workflow-gate.js'
	);
	const composed = (await _test_exports.composePrReviewPhaseVerdicts(
		tempDir,
		SESSION_ID,
		'reviewer',
	)) as unknown as { requiredInventory: string[] };
	return [...composed.requiredInventory].sort();
}

export interface DeadReviewerWorld {
	liveItems: string[];
	deadItems: string[];
}

export async function establishDeadReviewerWorld(): Promise<DeadReviewerWorld> {
	const ids = await establishFullInventory();
	const liveItems = ids.slice(0, Math.max(1, Math.floor(ids.length / 2)));
	const deadItems = ids.slice(liveItems.length);
	const { recordPrReviewValidationBatch, resolvePrReviewWriterRunId } =
		await import('../../../src/hooks/pr-workflow-gate.js');
	// Initial batch: live lane covers liveItems; dead lane covers deadItems.
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: LIVE_LANE,
				workflowLane: LIVE_LANE,
				reviewItemIds: liveItems,
			},
			{
				laneId: DEAD_LANE,
				workflowLane: DEAD_LANE,
				reviewItemIds: deadItems,
			},
		],
		{ batchId: 'n-of-m-batch-1', prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		'n-of-m-batch-1',
		'swarm-pr-review:reviewer',
		[{ laneId: LIVE_LANE, workflowLane: LIVE_LANE }],
		{ textOverride: reviewedRows(liveItems) },
	);
	await seedLivenessDeadLane({
		batchId: 'n-of-m-batch-1',
		laneId: DEAD_LANE,
		phase: 'reviewer',
	});
	// Reserve the run id the disclosure receipt persists under (the artifact
	// flow normally reserves it; the fixture harness bypasses that path).
	await resolvePrReviewWriterRunId(tempDir, SESSION_ID);
	// Retry batches 2 and 3 re-declare the dead lane's items; the lane is
	// liveness-dead in each (controller-observed, per-batch records).
	for (const suffix of ['2', '3']) {
		const batchId = `n-of-m-batch-${suffix}`;
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: DEAD_LANE,
					workflowLane: DEAD_LANE,
					reviewItemIds: deadItems,
				},
			],
			{ batchId, prHeadSha: HEAD_SHA },
		);
		await seedLivenessDeadLane({
			batchId,
			laneId: DEAD_LANE,
			phase: 'reviewer',
		});
	}
	return { liveItems, deadItems };
}

export type { BackgroundDelegationRecord };
