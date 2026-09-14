import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { CANDIDATE_HEADERS } from '../../../src/background/candidate-contract.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as dispatchInternals,
	executeCollectLaneResults,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';
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

const originalDiffStats = gateInternals.resolvePrReviewDiffStats;
const originalResolveRevision =
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync;
const originalResolveMergeBase = dispatchInternals.resolveExactMergeBaseAsync;
const originalGetSessionOps = dispatchInternals.getSessionOps;
const originalGetGeneratedAgentNames = dispatchInternals.getGeneratedAgentNames;
const originalLoadPluginConfig = dispatchInternals.loadPluginConfig;

let sentPrompts: string[] = [];
let promptStarted: Promise<void>;
let resolvePromptStarted: () => void;
let promptFinished: Promise<void>;
let resolvePromptFinished: () => void;
let releasePrompt: () => void;

function triggerEvaluation() {
	return PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map((trigger_id) => ({
		trigger_id,
		result: 'MATCHED' as const,
		evidence: `The exact checked-out diff requires focused review for ${trigger_id}`,
	}));
}

async function establishSettledBaseCoverage(): Promise<void> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
	await bindPrReviewBase(tempDir, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: PR_REVIEW_BASE_SHA,
	});
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, baseLanes, {
		batchId: 'base-for-2699',
		prHeadSha: HEAD_SHA,
		prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
	await persistBatch('base-for-2699', 'swarm-pr-review:base', baseLanes, {
		scope: PR_REVIEW_SCOPE,
	});
}

beforeEach(async () => {
	setupPrWorkflowGateFixtures();
	sentPrompts = [];
	promptStarted = new Promise((resolve) => {
		resolvePromptStarted = resolve;
	});
	promptFinished = new Promise((resolve) => {
		resolvePromptFinished = resolve;
	});
	const promptRelease = new Promise<void>((resolve) => {
		releasePrompt = resolve;
	});
	// Small diff stats force the controller-computed S tier, where a
	// consolidated micro lane owning multiple families is valid.
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 20,
		changedFiles: 1,
		hasSubmoduleChange: false,
	});
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	dispatchInternals.resolveExactMergeBaseAsync = async () => PR_REVIEW_BASE_SHA;
	dispatchInternals.loadPluginConfig = (directory) => ({
		...originalLoadPluginConfig(directory),
		pr_review_legacy_transcript_compatibility: true,
	});
	dispatchInternals.getGeneratedAgentNames = () => ['explorer'];
	dispatchInternals.getSessionOps = () => ({
		create: mock(async () => ({ data: { id: 'micro-2699-child' } })),
		promptAsync: mock(async (input) => {
			sentPrompts.push(input.body.parts[0].text);
			resolvePromptStarted();
			await promptRelease;
			resolvePromptFinished();
			return { data: undefined, error: undefined };
		}),
		status: mock(async () => ({
			data: { 'micro-2699-child': { type: 'idle' } },
			error: undefined,
		})),
		messages: mock(async () => ({
			data: [
				{
					info: { role: 'assistant' },
					parts: [
						{
							type: 'text',
							text: [
								CANDIDATE_HEADERS.micro_lane,
								`[CLEAN] | ${PR_REVIEW_REQUIRED_MICRO_LANE_IDS[0]} | focused diff review for the first family | no finding after tracing its assigned scope`,
								`[CLEAN] | ${PR_REVIEW_REQUIRED_MICRO_LANE_IDS[1]} | focused diff review for the second family | no finding after tracing its assigned scope`,
							].join('\n'),
						},
					],
				},
			],
			error: undefined,
		})),
		delete: mock(async () => undefined),
	});
	await establishSettledBaseCoverage();
});

afterEach(async () => {
	gateInternals.resolvePrReviewDiffStats = originalDiffStats;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		originalResolveRevision;
	dispatchInternals.resolveExactMergeBaseAsync = originalResolveMergeBase;
	dispatchInternals.loadPluginConfig = originalLoadPluginConfig;
	dispatchInternals.getSessionOps = originalGetSessionOps;
	dispatchInternals.getGeneratedAgentNames = originalGetGeneratedAgentNames;
	await teardownPrWorkflowGateFixtures();
});

describe('PR-review micro dispatch — regression: consolidated contract markers are controller-owned (#2699)', () => {
	test('launches a clean two-family consolidated micro lane and delivers its prompt', async () => {
		const [familyA, familyB] = PR_REVIEW_REQUIRED_MICRO_LANE_IDS;
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:micro',
				pr_head_sha: HEAD_SHA,
				base_ref: 'origin/main',
				base_sha: PR_REVIEW_BASE_SHA,
				scope: PR_REVIEW_SCOPE,
				trigger_evaluation: triggerEvaluation(),
				batch_id: 'micro-consolidated-2699',
				max_concurrent: 1,
				lanes: [
					{
						id: 'micro-family-sweep',
						agent: 'explorer',
						prompt:
							'Review the exact PR diff across both assigned risk families.',
						workflow_lane: familyA,
						owned_workflow_lanes: [familyA, familyB],
					},
				],
			},
			tempDir,
			{ sessionID: SESSION_ID },
		);

		// The prior path rejected its own appended controller contract as an
		// operator-authored marker before creating or prompting the child session.
		expect(result).toMatchObject({
			success: true,
			dispatched: 1,
			pending: 1,
		});
		await promptStarted;
		expect(sentPrompts).toHaveLength(1);
		expect(sentPrompts[0]).toContain('CONTROLLER-BOUND OUTPUT IDENTITY');
		expect(sentPrompts[0]).toContain(`"${familyA}"`);
		expect(sentPrompts[0]).toContain(`"${familyB}"`);

		releasePrompt();
		await promptFinished;
		await expect(
			executeCollectLaneResults(
				{
					batch_id: 'micro-consolidated-2699',
					wait: true,
					timeout_ms: 1_000,
					include_pending: true,
				},
				tempDir,
				{ sessionID: SESSION_ID },
			),
		).resolves.toMatchObject({ success: true, completed: 1, pending: 0 });
	});

	// Existing operator-authored marker rejection remains covered by
	// tests/unit/tools/dispatch-lanes-explorer-format.test.ts. This test proves
	// that controller-generated markers survive the real async construction path.
});
