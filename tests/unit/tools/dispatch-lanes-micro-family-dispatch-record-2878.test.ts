import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { PrReviewInlineTriggerRow } from '../../../src/background/pr-review-trigger-contract.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
	recordPrReviewMicroFamilyDispatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';
import { _internals as writerInternals } from '../../../src/tools/write-pr-review-trigger-eval.js';
import {
	HEAD_SHA,
	LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	PR_REVIEW_BASE_SHA,
	PR_REVIEW_SCOPE,
	persistBatch,
	REVISION_DIGEST,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

// Issue #2878 acceptance check C1 (NEW-SURFACE — RED at base): the
// micro-dispatch acknowledgment persists a bounded, restart-durable,
// batchId-idempotent per-family dispatch attempt record in PR-workflow gate
// state, which the dead-family admission counts to prove the retry budget was
// exhausted before disclosing a liveness-dead family.

const originalGetSessionOps = dispatchInternals.getSessionOps;
const originalGetGeneratedAgentNames = dispatchInternals.getGeneratedAgentNames;
const originalResolveRevisionAsync =
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync;
const originalResolveMergeBaseAsync =
	dispatchInternals.resolveExactMergeBaseAsync;
const originalResolveDiffStats = gateInternals.resolvePrReviewDiffStats;
const originalWriterResolveRevision =
	writerInternals.resolvePrWorkflowRevisionDigest;
const originalWriterResolveMergeBase = writerInternals.resolveMergeBase;
let createdSessions = 0;

const FAMILY = 'unclassified-risk';

function triggerEvaluation(): PrReviewInlineTriggerRow[] {
	return PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map((triggerId) => ({
		trigger_id: triggerId,
		result: 'MATCHED' as const,
		evidence: `Changed behavior requires focused review for ${triggerId}`,
	}));
}

async function establishBaseCoverage(): Promise<void> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
	await bindPrReviewBase(tempDir, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: PR_REVIEW_BASE_SHA,
	});
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: `base-${workflowLane}`,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, baseLanes, {
		batchId: 'family-record-base',
		prHeadSha: HEAD_SHA,
		prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
	await persistBatch('family-record-base', 'swarm-pr-review:base', baseLanes, {
		scope: PR_REVIEW_SCOPE,
	});
}

async function dispatchMicro(batchId: string) {
	return executeDispatchLanesAsync(
		{
			mode: 'swarm-pr-review:micro',
			pr_head_sha: HEAD_SHA,
			base_ref: 'origin/main',
			base_sha: PR_REVIEW_BASE_SHA,
			scope: PR_REVIEW_SCOPE,
			trigger_evaluation: triggerEvaluation(),
			batch_id: batchId,
			max_concurrent: 1,
			lanes: [
				{
					id: `${batchId}-lane`,
					agent: 'explorer',
					prompt: 'Review the exact PR diff for this risk family.',
					workflow_lane: FAMILY,
				},
			],
		},
		tempDir,
		{ sessionID: SESSION_ID },
	);
}

beforeEach(() => {
	setupPrWorkflowGateFixtures();
	createdSessions = 0;
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 500,
		changedFiles: 20,
		hasSubmoduleChange: false,
	});
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	dispatchInternals.resolveExactMergeBaseAsync = async () => PR_REVIEW_BASE_SHA;
	writerInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	writerInternals.resolveMergeBase = () => PR_REVIEW_BASE_SHA;
	dispatchInternals.getGeneratedAgentNames = () => ['explorer'];
	dispatchInternals.getSessionOps = () => ({
		create: mock(async () => ({
			data: { id: `family-record-child-${++createdSessions}` },
			error: undefined,
		})),
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		delete: mock(async () => undefined),
	});
});

afterEach(async () => {
	gateInternals.resolvePrReviewDiffStats = originalResolveDiffStats;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		originalResolveRevisionAsync;
	dispatchInternals.resolveExactMergeBaseAsync = originalResolveMergeBaseAsync;
	dispatchInternals.getGeneratedAgentNames = originalGetGeneratedAgentNames;
	dispatchInternals.getSessionOps = originalGetSessionOps;
	writerInternals.resolvePrWorkflowRevisionDigest =
		originalWriterResolveRevision;
	writerInternals.resolveMergeBase = originalWriterResolveMergeBase;
	await teardownPrWorkflowGateFixtures();
});

describe('PR-review micro-family dispatch attempt ledger (issue #2878)', () => {
	test('the micro-dispatch acknowledgment persists a per-family dispatch attempt record keyed by batch id and pr head', async () => {
		await establishBaseCoverage();
		const batchId = 'family-record-attempt-1';
		const result = await dispatchMicro(batchId);
		expect(result.success).toBe(true);

		const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
		const records = state?.prReviewMicroFamilyDispatches ?? [];
		expect(records.length).toBe(1);
		const record = records[0]!;
		expect(record.batchId).toBe(batchId);
		expect(record.prHeadSha).toBe(HEAD_SHA);
		expect(record.admittedAt).toBeTruthy();
		expect(record.lanes.length).toBe(1);
		expect(record.lanes[0]!.laneId).toBe(`${batchId}-lane`);
		expect(record.lanes[0]!.workflowLane).toBe(FAMILY);

		// Restart durability: drop the in-memory tracked-state cache and
		// re-read from disk — the record must survive a fresh process read.
		gateInternals.resetTrackedStateCache();
		const freshState = await readPrWorkflowGateState(tempDir, SESSION_ID);
		const freshRecords = freshState?.prReviewMicroFamilyDispatches ?? [];
		expect(freshRecords.length).toBe(1);
		expect(freshRecords[0]!.batchId).toBe(batchId);
	});

	test('a duplicate batchId append is idempotent with exactly one record per batch id', async () => {
		await establishBaseCoverage();
		const batchId = 'family-record-attempt-2';
		const result = await dispatchMicro(batchId);
		expect(result.success).toBe(true);

		// A crash between the acknowledgment and lane launch, followed by a
		// retry of the exact same dispatch call, re-records the same batch id:
		// the ledger must keep exactly one entry (no double-counted attempt).
		await recordPrReviewMicroFamilyDispatch(
			tempDir,
			SESSION_ID,
			[{ laneId: `${batchId}-lane`, workflowLane: FAMILY }],
			{ batchId, prHeadSha: HEAD_SHA },
		);
		const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
		const records = (state?.prReviewMicroFamilyDispatches ?? []).filter(
			(record) => record.batchId === batchId,
		);
		expect(records.length).toBe(1);
	});
});
