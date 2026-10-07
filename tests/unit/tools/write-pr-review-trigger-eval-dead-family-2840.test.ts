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
	type PrReviewLaneResultEnvelope,
	type PrReviewResultReceipt,
	prReviewLaneResultEnvelopeDigest,
} from '../../../src/background/pr-review-contract.js';
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

// Issue #2840 (AC6, TOCTOU cross-check): a liveness-shape micro lane whose
// durable record ALREADY holds a prReviewResultReceipt is not a dead family —
// its review finished (the receipt landed as the presumed-stale sweep fired,
// or later via parentRepair). The trigger-eval writer must refuse the
// dead-family admission and fail closed on the provenance chain instead of
// mislabeling real findings "presumed host abandonment". The receipt-less
// control (the #2835 shape) still admits with the disclosure.

const tempDirs: string[] = [];
const SESSION_ID = 'toctou-2840-session';
const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const BASE_REF = 'origin/main';
const REVISION_DIGEST = 'toctou-2840-revision';
const REVIEW_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;
const DEAD_TRIGGER = 'unclassified-risk';
const DEAD_BATCH = 'micro-batch-toctou';
const DEAD_LANE = 'lane-unclassified-toctou';
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
	findByBatchIdDetailed: writerInternals.findByBatchIdDetailed,
};

function tempRoot(): string {
	const root = canonicalMkdtemp('toctou-2840-');
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

/** A structurally valid receipt envelope whose owned lanes are all unresolved
 * (the shape a parent-repair submission carries for a dead child). */
function repairEnvelope(): PrReviewLaneResultEnvelope {
	return {
		schemaVersion: 1,
		outcome: 'INCOMPLETE',
		creditedLanes: [],
		findings: [],
		cleanAttestations: [],
		unresolved: [
			{
				workflowLane: DEAD_TRIGGER,
				reason: 'NOT_EXECUTED',
				detail: 'child died before submitting',
			},
		],
	};
}

function repairReceipt(): PrReviewResultReceipt {
	const envelope = repairEnvelope();
	return {
		schemaVersion: 1,
		mode: 'swarm-pr-review:micro',
		workflowInstanceId: 'wfi-toctou-2840',
		workflowRevision: 1,
		batchId: DEAD_BATCH,
		laneId: DEAD_LANE,
		workflowLane: DEAD_TRIGGER,
		ownedWorkflowLanes: [DEAD_TRIGGER],
		baseSha: BASE_SHA,
		headSha: HEAD_SHA,
		dispatchRevisionDigest: 'e'.repeat(64),
		childSessionId: `${DEAD_BATCH}-${DEAD_LANE}-session`,
		generation: 1,
		semanticEnvelopeDigest: prReviewLaneResultEnvelopeDigest(envelope),
		envelope,
		submittedBy: 'workflow_parent',
		submittedByParentSessionId: SESSION_ID,
		laneTerminalStateAtSubmission: 'stale',
	};
}

/** Settle the dead-shape micro lane; `withReceipt` additionally plants a
 * prReviewResultReceipt on the terminal result (the TOCTOU state). */
async function recordLivenessDeadMicroLane(
	root: string,
	withReceipt: boolean,
): Promise<void> {
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
			...(withReceipt ? { prReviewResultReceipt: repairReceipt() } : {}),
		},
	});
}

async function establishBoundReviewGate(
	root: string,
	withReceipt: boolean,
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
	// Issue #2878: the receipt-less control below must still admit, so the
	// fixture satisfies the enforced retry budget — initial dispatch plus two
	// retries, the cited dead batch last.
	for (const batchId of ['toctou-attempt-1', 'toctou-attempt-2', DEAD_BATCH]) {
		await recordPrReviewMicroFamilyDispatch(
			root,
			SESSION_ID,
			[{ laneId: DEAD_LANE, workflowLane: DEAD_TRIGGER }],
			{ batchId, prHeadSha: HEAD_SHA },
		);
	}
	await recordLivenessDeadMicroLane(root, withReceipt);
}

async function runWriter(
	root: string,
): Promise<{ success: boolean; message: string }> {
	return JSON.parse(
		await executeWritePrReviewTriggerEval(
			{
				run_id: 'toctou-2840-run',
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
	writerInternals.findByBatchIdDetailed =
		originalWriterInternals.findByBatchIdDetailed;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('issue #2840 — TOCTOU: a receipt-bearing lane is never a dead family', () => {
	test('liveness-shape lane WITH a prReviewResultReceipt fails closed on provenance, not dead-family admission', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root, true);
		const result = await runWriter(root);
		expect(result.success).toBe(false);
		expect(result.message).toContain(
			'does not reference a verifiable micro-lane provenance chain',
		);
	});

	test('control: the receipt-less #2835 shape still admits with the disclosure', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root, false);
		const result = await runWriter(root);
		expect(
			result.success,
			`receipt-less liveness-dead lane must still admit; writer said: ${result.message}`,
		).toBe(true);
	});

	test('PR review F-4: a receipt landing between the snapshot read and the fresh re-read still fails closed (the load-bearing conjunct)', async () => {
		// The tool reads the lane record twice: the snapshot predicate (the
		// short-circuit) and the fresh findByBatchIdDetailed re-read (the
		// load-bearing authority). This test simulates the exact TOCTOU race
		// the fresh read exists for: the receipt is ABSENT at the snapshot
		// read and PRESENT at the fresh one (it landed in between). Without
		// the !freshAlreadySubmittedReceipt conjunct the fresh predicate
		// admits the dead-family disclosure and this test fails.
		const root = tempRoot();
		await establishBoundReviewGate(root, true);
		const realFinder = writerInternals.findByBatchIdDetailed;
		let reads = 0;
		writerInternals.findByBatchIdDetailed = ((
			directory: string,
			batchId: string,
			options: unknown,
		) => {
			reads += 1;
			const outcome = realFinder(
				directory,
				batchId,
				options as Parameters<typeof realFinder>[2],
			);
			if (reads === 1 && outcome.status === 'ok') {
				// Strip the receipt from the SNAPSHOT view only: as far as the
				// first read is concerned the lane is still receipt-less.
				for (const record of outcome.value) {
					if (record.result?.prReviewResultReceipt) {
						record.result = { ...record.result };
						delete record.result.prReviewResultReceipt;
					}
					if (record.terminalResult?.result?.prReviewResultReceipt) {
						record.terminalResult = {
							...record.terminalResult,
							result: { ...record.terminalResult.result },
						};
						delete record.terminalResult.result.prReviewResultReceipt;
					}
				}
			}
			return outcome;
		}) as typeof realFinder;
		const result = await runWriter(root);
		expect(
			result.success,
			`a receipt observed by the fresh re-read must block the dead-family admission; writer said: ${result.message}`,
		).toBe(false);
		expect(result.message).toContain(
			'does not reference a verifiable micro-lane provenance chain',
		);
		// Both reads actually happened (snapshot + fresh) — the race was
		// genuinely exercised, not short-circuited away.
		expect(reads).toBeGreaterThanOrEqual(2);
	});
});
