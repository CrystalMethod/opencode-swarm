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

// Issue #2835 acceptance check C4 (DISCRIMINATING — RED at base).
//
// AC4: a dispatch_lanes call relying on the documented max_concurrent default
// ("defaults to lane count", schema at dispatch-lanes.ts:558-564) must pass
// the PR_REVIEW base-dispatch validation.
//
// Root cause D2: dispatch-lanes.ts tier-M/S structural validation
// (`parsed.data.max_concurrent !== parsed.data.lanes.length`) compares the RAW
// parsed value, so omitting max_concurrent (undefined) is BLOCKED with
// "with max_concurrent equal to the lane count" even though the documented
// default equals the lane count (3).

const SESSION_ID = 'c4-tier-m-default-session';
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

/** Three consolidated lanes partitioning all six base dimensions exactly
 * once — the depth-tier M initial base shape. max_concurrent is OMITTED. */
function tierMBaseLanes() {
	const dims = PR_REVIEW_BASE_DIMENSION_IDS;
	return [
		lane(`base-sweep-${dims[0]}`, dims[0], [dims[0], dims[1]]),
		lane(`base-sweep-${dims[2]}`, dims[2], [dims[2], dims[3]]),
		lane(`base-sweep-${dims[4]}`, dims[4], [dims[4], dims[5]]),
	];
}

beforeEach(async () => {
	directory = canonicalMkdtemp('c4-tier-m-default-');
	await initializeGitRepository(directory);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	// 300 changed lines / 12 files maps to depth tier M (floor 3 lanes).
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 300,
		changedFiles: 12,
		hasSubmoduleChange: false,
	});
	gateInternals.resolvePrReviewDiffStatsAsync = async (...args) =>
		gateInternals.resolvePrReviewDiffStats(...args);
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		'revision-c4';
	dispatchInternals.resolveExactMergeBaseAsync = async () => BASE_SHA;
	// Disable staged-base resilience so the structural tier check is reached
	// (same intent as installLegacyPrReviewPolicy in the dispatch suite).
	dispatchInternals.loadPluginConfig = (dir) => ({
		...originals.loadPluginConfig(dir),
		pr_review_resilience: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
	let sessionIndex = 0;
	dispatchInternals.getSessionOps = () => ({
		create: mock(async () => ({
			data: { id: `c4-lane-session-${sessionIndex++}` },
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

describe('C4: tier-M PR_REVIEW base dispatch relying on the documented max_concurrent default passes base-dispatch validation', () => {
	test('omitting max_concurrent is not BLOCKED for equal-to-lane-count', async () => {
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: BASE_REF,
				// max_concurrent deliberately OMITTED: the schema documents
				// "defaults to lane count" (3 lanes here).
				lanes: tierMBaseLanes(),
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		const message = String(result.message);
		// At base this is RED: the raw parsed undefined !== 3 comparison BLOCKS
		// the dispatch even though the documented default equals the lane count.
		expect(
			message,
			`dispatch relying on the documented max_concurrent default must proceed past the base-dispatch validation (later-stage outcomes are acceptable); dispatch said: ${message}`,
		).not.toContain(BLOCKED_MESSAGE);
	});
});
