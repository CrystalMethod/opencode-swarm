import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
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
	recordPrReviewMicroFamilyDispatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	executeWritePrReviewTriggerEval,
	PR_REVIEW_TRIGGER_DEFINITIONS,
	_internals as writerInternals,
} from '../../../src/tools/write-pr-review-trigger-eval.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Issue #2878 acceptance check C2 (DISCRIMINATING — RED at base): the
// dead-family admission fails closed when the bounded retry budget (initial
// dispatch plus PR_REVIEW_MICRO_FAMILY_RETRY_BUDGET retries) is not proven
// exhausted from the persisted per-family dispatch ledger — zero attempts,
// below-budget attempts, or a cited batch that is not among the recorded
// attempts. At base the admission discloses with zero attempts recorded, so
// every case below must observe success:false only after the fix.

const tempDirs: string[] = [];
const SESSION_ID = 'c2-retry-exhaustion-session';
const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const BASE_REF = 'origin/main';
const REVISION_DIGEST = 'c2-retry-exhaustion-revision';
const REVIEW_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;
const DEAD_TRIGGER = 'unclassified-risk';
const DEAD_BATCH = 'micro-batch-dead';
const DEAD_LANE = 'lane-unclassified-dead';
const STALE_REASON = `lane ${DEAD_LANE} presumed stale: idle host session past the stale horizon`;
const STALE_DIGEST = createHash('sha256').update(STALE_REASON).digest('hex');

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
	const root = canonicalMkdtemp('c2-retry-exhaustion-');
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

async function recordCompletedBaseLane(
	root: string,
	laneId: string,
): Promise<void> {
	const correlationId = `base-all-${laneId}-session`;
	const header =
		'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';
	const text = `${header}\n[CLEAN] | ${laneId} | exact reviewed diff | no candidate survived the focused review`;
	await recordPendingDelegation(root, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `base-all-${laneId}-call`,
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

async function recordFamilyDispatchAttempts(
	root: string,
	batchIds: string[],
): Promise<void> {
	for (const batchId of batchIds) {
		await recordPrReviewMicroFamilyDispatch(
			root,
			SESSION_ID,
			[{ laneId: DEAD_LANE, workflowLane: DEAD_TRIGGER }],
			{ batchId, prHeadSha: HEAD_SHA },
		);
	}
}

async function establishBoundReviewGate(
	root: string,
	attemptBatchIds: string[],
): Promise<void> {
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
	for (const lane of baseLanes) {
		await recordCompletedBaseLane(root, lane.laneId);
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
	await recordFamilyDispatchAttempts(root, attemptBatchIds);
}

async function evaluate(root: string, runId: string) {
	return JSON.parse(
		await executeWritePrReviewTriggerEval(
			{
				run_id: runId,
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: BASE_REF,
				rows: rows(),
			},
			root,
			{ sessionID: SESSION_ID },
		),
	) as { success: boolean; message: string };
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

describe('C2: dead-family disclosure fails closed when the retry budget is not exhausted (issue #2878)', () => {
	test('admission fails closed when zero dispatch attempts are recorded for the dead family', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root, []);
		const result = await evaluate(root, 'c2-zero-attempts-run');

		expect(
			result.success,
			`zero recorded attempts must fail closed; writer said: ${result.message}`,
		).toBe(false);
		expect(result.message).toContain(DEAD_TRIGGER);
		expect(result.message).toMatch(/dispatch/i);
		expect(result.message).toContain('0 dispatch attempt');
		expect(result.message).toContain('retry budget');
		expect(
			existsSync(join(root, '.swarm', 'pr-review')),
			'no receipt may be persisted on a fail-closed admission',
		).toBe(false);
	});

	test('admission fails closed below budget even when the cited batch is recorded', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root, ['micro-attempt-1', DEAD_BATCH]);
		const result = await evaluate(root, 'c2-below-budget-run');

		expect(
			result.success,
			`two of three attempts must fail closed; writer said: ${result.message}`,
		).toBe(false);
		expect(result.message).toContain('2 dispatch attempt');
		expect(result.message).toContain('retry budget');
		expect(
			existsSync(join(root, '.swarm', 'pr-review')),
			'no receipt may be persisted on a fail-closed admission',
		).toBe(false);
	});

	test('admission fails closed at budget when the cited batch is not among recorded attempts', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root, [
			'attempt-1',
			'attempt-2',
			'attempt-3',
		]);
		const result = await evaluate(root, 'c2-foreign-batch-run');

		expect(
			result.success,
			`a cited batch outside the counted attempts must fail closed; writer said: ${result.message}`,
		).toBe(false);
		expect(result.message).toContain(
			'not among the recorded dispatch attempts',
		);
		expect(
			existsSync(join(root, '.swarm', 'pr-review')),
			'no receipt may be persisted on a fail-closed admission',
		).toBe(false);
	});
});
