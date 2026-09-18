import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	executeWritePrReviewTriggerEval,
	PR_REVIEW_TRIGGER_DEFINITIONS,
	_internals as writerInternals,
} from '../../../src/tools/write-pr-review-trigger-eval.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Issue #2835 acceptance check C1 (DISCRIMINATING — RED at base).
//
// After the bounded retry budget for a MATCHED micro family is exhausted with
// every family lane liveness-dead and no retained artifact, the controller
// must be able to persist a truthful trigger-eval receipt carrying a durable
// dead-family disclosure naming the dead lane (batch/lane identity, terminal
// liveness status).
//
// Root cause D1: write-pr-review-trigger-eval.ts:387-414 treats the missing
// outputRef on a sweep-settled liveness-terminal lane as a provenance FAILURE
// and returns success:false ("does not reference a verifiable micro-lane
// provenance chain"), so no receipt — and no disclosure — can ever be written.

const tempDirs: string[] = [];
const SESSION_ID = 'c1-dead-family-session';
const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const BASE_REF = 'origin/main';
const REVISION_DIGEST = 'c1-dead-family-revision';
const REVIEW_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;
const DEAD_TRIGGER = 'unclassified-risk';
const DEAD_BATCH = 'micro-batch-dead';
const DEAD_LANE = 'lane-unclassified-dead';
// Exact idle-host sweep shape (src/background/pending-delegations.ts /
// src/tools/dispatch-lanes.ts liveness settlement): a synthesized result with
// error/chars/truncated/digest and workflowLaneFailureClass 'liveness' — and
// NO outputRef, because no artifact was retained.
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
	const root = canonicalMkdtemp('c1-dead-family-');
	mkdirSync(join(root, '.git'), { recursive: true });
	tempDirs.push(root);
	return root;
}

/** Ledger where only the mandatory fallback family is MATCHED; every other
 * family is NOT_TRIGGERED. The MATCHED row cites the dead lane's tuple. */
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

/** Settle the unclassified-risk micro lane in the exact presumed-stale sweep
 * shape: durable terminal status 'stale' with a synthesized liveness result
 * and NO retained artifact (no storeLaneOutput, no outputRef). */
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

async function establishBoundReviewGate(root: string): Promise<void> {
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
}

function receiptPath(root: string, runId: string): string {
	return join(root, '.swarm', 'pr-review', runId, 'trigger-eval.json');
}

/**
 * Durable-content disclosure matcher, deliberately field-name agnostic: accept
 * either a dedicated dead-lane disclosure array or a coverage_degradations
 * style entry, as long as some receipt entry durably names the trigger family,
 * the batch/lane identity, and a terminal liveness cause.
 */
function findDeadLaneDisclosure(receipt: Record<string, unknown>): unknown {
	const entryLists = Object.values(receipt).filter(
		(value): value is unknown[] => Array.isArray(value),
	);
	for (const list of entryLists) {
		for (const entry of list) {
			if (typeof entry !== 'object' || entry === null) continue;
			const record = entry as Record<string, unknown>;
			const text = JSON.stringify(record);
			if (!text.includes(DEAD_BATCH) || !text.includes(DEAD_LANE)) continue;
			if (!text.includes(DEAD_TRIGGER)) continue;
			const terminalStatus = [
				record.status,
				record.lane_status,
				record.terminal_status,
				record.failure_class,
				record.workflowLaneFailureClass,
				record.workflow_lane_failure_class,
			].filter((value): value is string => typeof value === 'string');
			const namesLivenessCause =
				/liveness|presumed (stale|dead)|host session unobservable/i.test(
					text,
				) ||
				terminalStatus.includes('stale') ||
				terminalStatus.includes('error');
			if (namesLivenessCause) return record;
		}
	}
	return null;
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

describe('C1: write_pr_review_trigger_eval must persist a dead-family disclosure for a liveness-dead micro lane', () => {
	test('a sweep-settled liveness-dead MATCHED family yields success:true plus a durable dead-lane disclosure on the receipt', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		const result = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'c1-dead-family-run',
					pr_head_sha: HEAD_SHA,
					base_sha: BASE_SHA,
					base_ref: BASE_REF,
					rows: rows(),
				},
				root,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean; message: string };

		// At base this fails: the writer returns success:false with
		// "does not reference a verifiable micro-lane provenance chain" because
		// the liveness-settled sweep result carries no outputRef (root cause D1).
		expect(
			result.success,
			`writer must succeed for a liveness-dead MATCHED family; writer said: ${result.message}`,
		).toBe(true);

		const receiptFile = receiptPath(root, 'c1-dead-family-run');
		expect(
			existsSync(receiptFile),
			'truthful trigger-eval receipt must be persisted',
		).toBe(true);
		const receipt = JSON.parse(readFileSync(receiptFile, 'utf-8')) as Record<
			string,
			unknown
		>;
		const disclosure = findDeadLaneDisclosure(receipt);
		expect(
			disclosure,
			`receipt must durably disclose the dead lane (${DEAD_TRIGGER} at ${DEAD_BATCH}/${DEAD_LANE}) with its terminal liveness cause; receipt: ${JSON.stringify(receipt)}`,
		).not.toBeNull();
	});
});
