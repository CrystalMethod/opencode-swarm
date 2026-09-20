import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { findByBatchId } from '../../../src/background/pending-delegations.js';
import {
	_test_exports,
	activatePrWorkflow,
	enforcePrReviewBaseDimensions,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeSubmitPrReviewResult } from '../../../src/tools/submit-pr-review-result.js';
import {
	HEAD_SHA,
	persistBatch,
	REVISION_DIGEST,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

/**
 * Issue #2859 (F3, review finding F-001): the producer and consumer halves of
 * the submit-rejection journal are joined HERE, through the production seam
 * inside `workflowArtifactHasContractMarker` — the sole consumer of
 * `latestPrReviewSubmitRejectionMessage`. The sibling
 * collect-lanes-submit-rejection-visibility suite drives the real producer
 * (journal write) and asserts the formatted message with a hand-injected
 * literal; this suite drives a real rejection into the real gate state on
 * disk, reads the state back through the real persistence reader, and asserts
 * the surfaced contract-failure diagnostic carries the journaled reason.
 * Deleting the `lastSubmitRejection` spread in the gate fails the first test.
 */

const BATCH = 'base-2859-join';
const CHILD = 'child-2859-join';
const LANE = 'correctness-state';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

async function setupFailingBaseLane(): Promise<void> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
	await enforcePrReviewBaseDimensions(
		tempDir,
		SESSION_ID,
		[{ laneId: LANE, workflowLane: LANE }],
		{
			batchId: BATCH,
			prHeadSha: HEAD_SHA,
			prReviewResiliencePolicy: { enabled: false },
		},
	);
	// The lane's artifact is ordinary prose: legacy transcript compatibility is
	// disabled and there is no structured receipt, so discovery validation
	// deterministically fails with the missing-receipt reason.
	await persistBatch(
		BATCH,
		'swarm-pr-review:base',
		[{ laneId: LANE, workflowLane: LANE }],
		{
			subagentSessionId: CHILD,
			prReviewLegacyTranscriptCompatibility: false,
			textOverride: 'ordinary prose without a structured receipt',
		},
	);
}

async function journalRealSchemaRejection(): Promise<string> {
	// A real child rejection through the public tool layer — the same producer
	// the visibility suite exercises, now writing into the gate state the
	// fixture workflow created (parent session, real persistence path).
	const raw = await executeSubmitPrReviewResult(
		{
			schemaVersion: '2',
			revisionDigest: 'd'.repeat(64),
			result: { schemaVersion: 1 },
		},
		tempDir,
		{ sessionID: CHILD },
	);
	const outcome = JSON.parse(raw) as { success: boolean };
	expect(outcome.success).toBeFalse();
	return raw;
}

describe('submit-rejection journal → discovery contract failure join (#2859 F-001)', () => {
	test('the gate-side failure diagnostic carries the journaled rejection', async () => {
		await setupFailingBaseLane();
		await journalRealSchemaRejection();

		_test_exports.resetTrackedStateCache();
		const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(state).toBeDefined();
		const journalled = state?.prReviewSubmitRejections?.find(
			(entry) => entry.childSessionId === CHILD,
		);
		expect(journalled?.message).toContain('Invalid PR-review result');

		const [record] = findByBatchId(tempDir, BATCH, {
			parentSessionId: SESSION_ID,
		}).filter((entry) => entry.subagentSessionId === CHILD);
		expect(record?.result?.outputRef).toBeTruthy();

		const diagnostics: string[] = [];
		const settled = _test_exports.workflowArtifactHasContractMarker(
			tempDir,
			state!,
			record!,
			'swarm-pr-review:base',
			LANE,
			undefined,
			REVISION_DIGEST,
			record?.ownedWorkflowLanes,
			diagnostics,
		);
		expect(settled).toBeFalse();
		const surfaced = diagnostics.join('\n');
		expect(surfaced).toContain('missing structured receipt');
		expect(surfaced).toContain('; last rejected submit_pr_review_result: ');
		expect(surfaced).toContain('Invalid PR-review result');
		expect(surfaced).toContain(journalled!.message.slice(0, 64));
	});

	test('without a journalled rejection the diagnostic keeps its original form', async () => {
		await setupFailingBaseLane();
		// No submit attempt: nothing journaled for CHILD.

		_test_exports.resetTrackedStateCache();
		const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(
			state?.prReviewSubmitRejections?.some(
				(entry) => entry.childSessionId === CHILD,
			),
		).toBeFalsy();

		const [record] = findByBatchId(tempDir, BATCH, {
			parentSessionId: SESSION_ID,
		}).filter((entry) => entry.subagentSessionId === CHILD);
		expect(record).toBeDefined();

		const diagnostics: string[] = [];
		const settled = _test_exports.workflowArtifactHasContractMarker(
			tempDir,
			state!,
			record!,
			'swarm-pr-review:base',
			LANE,
			undefined,
			REVISION_DIGEST,
			record?.ownedWorkflowLanes,
			diagnostics,
		);
		expect(settled).toBeFalse();
		const surfaced = diagnostics.join('\n');
		expect(surfaced).toContain('missing structured receipt');
		expect(surfaced).not.toContain('; last rejected submit_pr_review_result: ');
	});
});
