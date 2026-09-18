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
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	executeWritePrReviewTriggerEval,
	PR_REVIEW_TRIGGER_DEFINITIONS,
	_internals as writerInternals,
} from '../../../src/tools/write-pr-review-trigger-eval.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Issue #2835 acceptance check C3 (PRESERVING — GREEN at base, must STAY green
// after the fix).
//
// AC3: provenance for lanes WITH retained artifacts is unchanged —
// forged/mismatched provenance still fails closed. The dead-family disclosure
// may only be keyed on durable terminal lane records verified by the writer,
// never on caller assertions. Two pins:
//   A. a MATCHED row citing a batch/lane tuple that was never dispatched;
//   B. a lane record that exists and owns the family but is NOT
//      liveness-terminal (workflowLaneFailureClass 'contract') and retains an
//      artifact whose identity mismatches the cited lane.
// Both must return success:false with "does not reference a verifiable
// micro-lane provenance chain" — at base AND after any #2835 fix.

const tempDirs: string[] = [];
const SESSION_ID = 'c3-provenance-pin-session';
const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const BASE_REF = 'origin/main';
const REVISION_DIGEST = 'c3-provenance-pin-revision';
const REVIEW_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;
const DEAD_TRIGGER = 'unclassified-risk';
const PROVENANCE_FAILURE =
	'does not reference a verifiable micro-lane provenance chain';

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
	const root = canonicalMkdtemp('c3-provenance-pin-');
	mkdirSync(join(root, '.git'), { recursive: true });
	tempDirs.push(root);
	return root;
}

function rows(sourceBatchId: string, sourceLaneId: string) {
	return PR_REVIEW_TRIGGER_DEFINITIONS.map((definition) =>
		definition.id === DEAD_TRIGGER
			? {
					trigger_id: definition.id,
					result: 'MATCHED' as const,
					evidence: `mandatory review focus for ${definition.id}`,
					source_batch_id: sourceBatchId,
					source_lane_id: sourceLaneId,
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

/**
 * A NON-liveness terminal micro lane for the family: status 'error' with
 * workflowLaneFailureClass 'contract' and a retained artifact — but the
 * artifact was stored under a DIFFERENT lane id, so its identity mismatches
 * the cited (batch, lane) tuple. Provenance must still fail closed; the
 * dead-family disclosure may never absorb a contract-class failure with a
 * mismatched retained artifact.
 */
async function recordContractFailureMicroLaneWithMismatchedArtifact(
	root: string,
	batchId: string,
	laneId: string,
): Promise<void> {
	const correlationId = `${batchId}-${laneId}-session`;
	const text =
		'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags\n[CANDIDATE] | C-GHOST | HIGH | correctness | file.ts:1 | claim | INVARIANT | evidence | HIGH | ORDINARY | ';
	await recordPendingDelegation(root, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `${batchId}-call`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId,
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
	// Retained artifact stored under a foreign lane id: identity mismatch.
	const stored = storeLaneOutput(root, {
		batchId,
		laneId: 'foreign-lane-identity',
		agent: 'explorer',
		role: 'explorer',
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: 'swarm-pr-review:micro',
		workflowLane: DEAD_TRIGGER,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		scope: REVIEW_SCOPE,
		source: 'collect_lane_results',
		text,
	});
	await appendDelegationTransition(root, correlationId, {
		status: 'error',
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
			workflowLaneFailureClass: 'contract',
		},
	});
}

/**
 * An OPERATOR-CANCELLED micro lane for the family: status 'cancelled' with
 * typed liveness class and NO retained artifact — the exact record shape
 * cancel_pending produces. It must NOT be admitted as a dead family: a
 * cancellation is the controller's own controlled act and must be
 * re-dispatched, never disclosed. Only the sweep's stale/error shapes
 * qualify (issue #2835).
 */
async function recordCancelledLivenessMicroLane(
	root: string,
	batchId: string,
	laneId: string,
): Promise<void> {
	const correlationId = `${batchId}-${laneId}-session`;
	const reason = `lane ${laneId} cancelled by controller`;
	await recordPendingDelegation(root, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `${batchId}-call`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId,
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
		status: 'cancelled',
		result: {
			error: reason,
			chars: reason.length,
			truncated: false,
			digest: createHash('sha256').update(reason).digest('hex'),
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
}

async function bindLedger(root: string): Promise<void> {
	await bindPrReviewTriggerLedger(
		root,
		SESSION_ID,
		rows('ledger-batch', 'ledger-lane').map(
			({ trigger_id, result, evidence }) => ({ trigger_id, result, evidence }),
		),
	);
}

async function runWriter(
	root: string,
	runId: string,
	sourceBatchId: string,
	sourceLaneId: string,
): Promise<{ success: boolean; message: string }> {
	return JSON.parse(
		await executeWritePrReviewTriggerEval(
			{
				run_id: runId,
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: BASE_REF,
				rows: rows(sourceBatchId, sourceLaneId),
			},
			root,
			{ sessionID: SESSION_ID },
		),
	);
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

describe('C3: forged and identity-mismatched provenance still fail closed (no weakening from the dead-family disclosure)', () => {
	test('a MATCHED row citing a never-dispatched batch/lane tuple is rejected', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		await bindLedger(root);
		// No micro lane records exist at all — the cited tuple is pure forgery.
		const result = await runWriter(
			root,
			'c3-forged-run',
			'never-dispatched-batch',
			'ghost-lane',
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain(PROVENANCE_FAILURE);
	});

	test('a contract-class error lane with a mismatched retained artifact is rejected', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		await bindLedger(root);
		await recordContractFailureMicroLaneWithMismatchedArtifact(
			root,
			'micro-batch-contract',
			'lane-unclassified-contract',
		);
		const result = await runWriter(
			root,
			'c3-contract-run',
			'micro-batch-contract',
			'lane-unclassified-contract',
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain(PROVENANCE_FAILURE);
	});

	test('an operator-cancelled liveness lane with no artifact is rejected (cancellation is not host abandonment)', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		await bindLedger(root);
		await recordCancelledLivenessMicroLane(
			root,
			'micro-batch-cancelled',
			'lane-unclassified-cancelled',
		);
		const result = await runWriter(
			root,
			'c3-cancelled-run',
			'micro-batch-cancelled',
			'lane-unclassified-cancelled',
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain(PROVENANCE_FAILURE);
	});
});
