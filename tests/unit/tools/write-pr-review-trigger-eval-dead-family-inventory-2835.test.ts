import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	bindPrReviewTriggerLedger,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	executeWritePrReviewTriggerEval,
	PR_REVIEW_TRIGGER_DEFINITIONS,
	_internals as writerInternals,
} from '../../../src/tools/write-pr-review-trigger-eval.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Issue #2835 acceptance check C2 (DISCRIMINATING — RED at base).
//
// With a dead-family-disclosed trigger-eval receipt persisted (produced by the
// REAL writer, never hand-written), the workflow must admit the disclosed
// PARTIAL path: the reviewer candidate-inventory derivation (the same path
// exercised by tests/unit/hooks/pr-workflow-gate-degraded-inventory.test.ts)
// must skip the dead family instead of throwing
// "mandatory micro-lane provenance is missing or invalid".
//
// At base this probe is RED at the writer step (root cause D1): the writer
// cannot persist the receipt at all, so the dead lane has no disclosed exit
// and abort is the only compliant path.

const tempDirs: string[] = [];
const SESSION_ID = 'c2-dead-family-session';
const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const BASE_REF = 'origin/main';
const REVISION_DIGEST = 'c2-dead-family-revision';
const REVIEW_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;
const DEAD_TRIGGER = 'unclassified-risk';
const DEAD_BATCH = 'micro-batch-dead';
const DEAD_LANE = 'lane-unclassified-dead';
const STALE_REASON = `lane ${DEAD_LANE} presumed stale: idle host session past the stale horizon`;
const STALE_DIGEST = createHash('sha256').update(STALE_REASON).digest('hex');
const BASE_CANDIDATE_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_lane, index) => `C-${index}`,
);

const originalGateInternals = {
	head: gateInternals.resolveCurrentGitHead,
	headAsync: gateInternals.resolveCurrentGitHeadAsync,
	clean: gateInternals.resolveIsWorkingTreeClean,
	cleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
	gateDigest: gateInternals.resolvePrWorkflowRevisionDigest,
	diffStats: gateInternals.resolvePrReviewDiffStats,
	diffStatsAsync: gateInternals.resolvePrReviewDiffStatsAsync,
};
const originalWriterInternals = {
	digest: writerInternals.resolvePrWorkflowRevisionDigest,
	mergeBase: writerInternals.resolveMergeBase,
};

function tempRoot(): string {
	const root = canonicalMkdtemp('c2-dead-family-');
	mkdirSync(join(root, '.git'), { recursive: true });
	tempDirs.push(root);
	return root;
}

function rows() {
	return PR_REVIEW_TRIGGER_DEFINITIONS.map((definition) =>
		definition.id === DEAD_TRIGGER
			? {
					trigger_id: definition.id,
					result: 'MATCHED' as const,
					evidence: `mandatory review focus for ${definition.id}`,
					source_batch_id: DEAD_BATCH,
					source_lane_id: DEAD_LANE,
				}
			: {
					trigger_id: definition.id,
					result: 'NOT_TRIGGERED' as const,
					evidence: `no ${definition.id} surface is touched by this change set`,
				},
	);
}

/** Base lane settled with a real retained [CANDIDATE] artifact (the inventory
 * source shape used by the degraded-inventory suite). */
async function recordCompletedBaseLane(
	root: string,
	laneId: string,
	index: number,
): Promise<void> {
	const correlationId = `base-all--${laneId}`;
	const header =
		'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';
	const text = `${header}\nC-${index} | ${laneId} | HIGH | correctness | file.ts:1 | claim | evidence | impact | HIGH | ORDINARY | `;
	await recordPendingDelegation(root, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `call-${correlationId}`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'base-all',
		laneId,
		mode: 'swarm-pr-review:base',
		prReviewLegacyTranscriptCompatibility: true,
		workflowLane: laneId,
		workspace: {
			directory: root,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: REVIEW_SCOPE,
		},
	});
	const stored = storeLaneOutput(root, {
		batchId: 'base-all',
		laneId,
		agent: 'explorer',
		role: 'explorer',
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: 'swarm-pr-review:base',
		workflowLane: laneId,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		scope: REVIEW_SCOPE,
		source: 'collect_lane_results',
		text,
	});
	await appendDelegationTransition(root, correlationId, {
		status: 'completed',
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
	});
}

async function recordLivenessDeadMicroLane(root: string): Promise<void> {
	const correlationId = `${DEAD_BATCH}-${DEAD_LANE}-session`;
	await recordPendingDelegation(root, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `${DEAD_BATCH}-call`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: DEAD_BATCH,
		laneId: DEAD_LANE,
		mode: 'swarm-pr-review:micro',
		prReviewLegacyTranscriptCompatibility: true,
		workflowLane: DEAD_TRIGGER,
		workspace: {
			directory: root,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: REVIEW_SCOPE,
		},
	});
	await appendDelegationTransition(root, correlationId, {
		status: 'stale',
		result: {
			error: STALE_REASON,
			chars: STALE_REASON.length,
			truncated: false,
			digest: STALE_DIGEST,
			workflowLaneFailureClass: 'liveness',
		},
	});
}

async function establishState(root: string): Promise<void> {
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 10,
		changedFiles: 1,
		hasSubmoduleChange: false,
	});
	writerInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	writerInternals.resolveMergeBase = () => BASE_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	gateInternals.resolvePrReviewDiffStatsAsync = async (dir, base, head) =>
		gateInternals.resolvePrReviewDiffStats(dir, base, head);
	await activatePrWorkflow(root, SESSION_ID, 'PR_REVIEW');
	await bindPrReviewBase(root, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: BASE_REF,
		baseSha: BASE_SHA,
	});
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(root, SESSION_ID, baseLanes, {
		batchId: 'base-all',
		prHeadSha: HEAD_SHA,
	});
	for (const [index, lane] of baseLanes.entries()) {
		await recordCompletedBaseLane(root, lane.laneId, index);
	}
	await bindPrReviewTriggerLedger(
		root,
		SESSION_ID,
		rows().map(({ trigger_id, result, evidence }) => ({
			trigger_id,
			result,
			evidence,
		})),
	);
	await recordLivenessDeadMicroLane(root);
}

afterEach(() => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originalGateInternals.head;
	gateInternals.resolveCurrentGitHeadAsync = originalGateInternals.headAsync;
	gateInternals.resolveIsWorkingTreeClean = originalGateInternals.clean;
	gateInternals.resolveIsWorkingTreeCleanAsync =
		originalGateInternals.cleanAsync;
	gateInternals.resolvePrWorkflowRevisionDigest =
		originalGateInternals.gateDigest;
	gateInternals.resolvePrReviewDiffStats = originalGateInternals.diffStats;
	gateInternals.resolvePrReviewDiffStatsAsync =
		originalGateInternals.diffStatsAsync;
	writerInternals.resolvePrWorkflowRevisionDigest =
		originalWriterInternals.digest;
	writerInternals.resolveMergeBase = originalWriterInternals.mergeBase;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('C2: a dead-family-disclosed receipt opens the disclosed PARTIAL inventory path', () => {
	test('reviewer inventory skips the disclosed dead family instead of throwing mandatory micro-lane provenance', async () => {
		const root = tempRoot();
		await establishState(root);

		// Step 1: persist the receipt through the REAL writer. At base this is
		// the RED step — the writer refuses the liveness-dead lane (root cause
		// D1), so no receipt and no disclosed PARTIAL path can exist.
		const writerResult = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'c2-dead-family-run',
					pr_head_sha: HEAD_SHA,
					base_sha: BASE_SHA,
					base_ref: BASE_REF,
					rows: rows(),
				},
				root,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean; message: string };
		expect(
			writerResult.success,
			`writer must persist the dead-family-disclosed receipt; writer said: ${writerResult.message}`,
		).toBe(true);

		// Step 2: the candidate-inventory derivation (inside
		// recordPrReviewValidationBatch for the reviewer phase) must admit the
		// disclosed PARTIAL path for the dead family.
		let inventoryError: unknown;
		try {
			await recordPrReviewValidationBatch(
				root,
				SESSION_ID,
				'reviewer',
				[
					{
						laneId: 'review-all',
						workflowLane: 'review-all',
						reviewItemIds: BASE_CANDIDATE_IDS,
					},
				],
				{ batchId: 'review-all', prHeadSha: HEAD_SHA },
			);
		} catch (error) {
			inventoryError = error;
		}
		expect(
			String(inventoryError),
			`the disclosed dead family must be skipped-with-disclosure, not re-blocked at the inventory; inventory said: ${String(inventoryError)}`,
		).not.toContain('mandatory micro-lane provenance is missing or invalid');
		expect(
			inventoryError,
			`reviewer validation batch must be admitted on the disclosed PARTIAL path; error: ${String(inventoryError)}`,
		).toBeUndefined();
	});
});
