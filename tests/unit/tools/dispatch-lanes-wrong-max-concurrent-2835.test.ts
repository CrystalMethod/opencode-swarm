import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

// Issue #2835 acceptance check C5 (PRESERVING — GREEN at base, must STAY green
// after the fix).
//
// AC4 second half: an explicit non-matching max_concurrent (2 with 3 lanes)
// must still FAIL the PR_REVIEW base-dispatch validation with the same
// "with max_concurrent equal to the lane count" message. Fixing the
// documented-default handling (D2) must not weaken the explicit-mismatch
// rejection.

const SESSION_ID = 'c5-tier-m-wrong-session';
const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const BASE_REF = 'origin/main';
const BLOCKED_MESSAGE = 'with max_concurrent equal to the lane count';

const originals = {
	gateHead: gateInternals.resolveCurrentGitHead,
	gateHeadAsync: gateInternals.resolveCurrentGitHeadAsync,
	gateClean: gateInternals.resolveIsWorkingTreeClean,
	gateCleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
	gateDiffStats: gateInternals.resolvePrReviewDiffStats,
	gateDiffStatsAsync: gateInternals.resolvePrReviewDiffStatsAsync,
	dispatchDigest: dispatchInternals.resolvePrWorkflowRevisionDigestAsync,
	dispatchMergeBase: dispatchInternals.resolveExactMergeBaseAsync,
	loadPluginConfig: dispatchInternals.loadPluginConfig,
	getSessionOps: dispatchInternals.getSessionOps,
};

let directory = '';

function lane(id: string, workflowLane: string, ownedWorkflowLanes: string[]) {
	return {
		id,
		agent: 'explorer',
		prompt: `Inspect ${id} across the exact reviewed diff`,
		workflow_lane: workflowLane,
		owned_workflow_lanes: ownedWorkflowLanes,
	};
}

function tierMBaseLanes() {
	const dims = PR_REVIEW_BASE_DIMENSION_IDS;
	return [
		lane(`base-sweep-${dims[0]}`, dims[0], [dims[0], dims[1]]),
		lane(`base-sweep-${dims[2]}`, dims[2], [dims[2], dims[3]]),
		lane(`base-sweep-${dims[4]}`, dims[4], [dims[4], dims[5]]),
	];
}

beforeEach(async () => {
	directory = canonicalMkdtemp('c5-tier-m-wrong-');
	await initializeGitRepository(directory);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 300,
		changedFiles: 12,
		hasSubmoduleChange: false,
	});
	gateInternals.resolvePrReviewDiffStatsAsync = async (...args) =>
		gateInternals.resolvePrReviewDiffStats(...args);
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		'revision-c5';
	dispatchInternals.resolveExactMergeBaseAsync = async () => BASE_SHA;
	dispatchInternals.loadPluginConfig = (dir) => ({
		...originals.loadPluginConfig(dir),
		pr_review_resilience: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
	let sessionIndex = 0;
	dispatchInternals.getSessionOps = () => ({
		create: mock(async () => ({
			data: { id: `c5-lane-session-${sessionIndex++}` },
		})),
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		delete: mock(async () => undefined),
	});
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originals.gateHead;
	gateInternals.resolveCurrentGitHeadAsync = originals.gateHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = originals.gateClean;
	gateInternals.resolveIsWorkingTreeCleanAsync = originals.gateCleanAsync;
	gateInternals.resolvePrReviewDiffStats = originals.gateDiffStats;
	gateInternals.resolvePrReviewDiffStatsAsync = originals.gateDiffStatsAsync;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		originals.dispatchDigest;
	dispatchInternals.resolveExactMergeBaseAsync = originals.dispatchMergeBase;
	dispatchInternals.loadPluginConfig = originals.loadPluginConfig;
	dispatchInternals.getSessionOps = originals.getSessionOps;
	rmSync(directory, { recursive: true, force: true });
});

describe('C5: an explicitly wrong max_concurrent still fails tier-M base dispatch validation', () => {
	test('max_concurrent 2 with 3 lanes is BLOCKED with the equal-to-lane-count message', async () => {
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: BASE_REF,
				max_concurrent: 2, // explicitly wrong: 3 lanes require 3
				lanes: tierMBaseLanes(),
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain(BLOCKED_MESSAGE);
	});
});
