import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import {
	PrReviewResultReceiptSchema,
	prReviewLaneResultEnvelopeDigest,
} from '../../../src/background/pr-review-contract';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	bindPrReviewTriggerLedger,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate';
import {
	executeWritePrReviewTriggerEval,
	PR_REVIEW_TRIGGER_DEFINITIONS,
	_internals as writerInternals,
} from '../../../src/tools/write-pr-review-trigger-eval';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Shared fixtures for the issue #3094 followup tests (split out of the test
// file for the FR-006 500-line cap; NOT part of the frozen acceptance
// manifest — trigger-eval-receipt-coverage.test.ts keeps its own frozen copy).

export const tempDirs: string[] = [];
export const SESSION_ID = 'trigger-eval-receipt-coverage-followup';
export const HEAD_SHA = 'abc123';
export const REVISION_DIGEST =
	'5f2a9c0b81d34e76a0c2f1b98d7e6a53c49018f2b6d3e7a9410cd58b2f7e6a31';
export const RECEIPT_ONLY_TEXT =
	'The structured result was already submitted via submit_pr_review_result; this transcript contains no protocol rows.';
export const MICRO_HEADER =
	'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';
const BASE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';
const REVIEW_SCOPE = `complete PR diff def456...${HEAD_SHA}`;

export const originalSeams = {
	gateHead: gateInternals.resolveCurrentGitHead,
	gateHeadAsync: gateInternals.resolveCurrentGitHeadAsync,
	gateClean: gateInternals.resolveIsWorkingTreeClean,
	gateCleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
	gateRevisionDigest: gateInternals.resolvePrWorkflowRevisionDigest,
	gateDiffStats: gateInternals.resolvePrReviewDiffStats,
	gateDiffStatsAsync: gateInternals.resolvePrReviewDiffStatsAsync,
	writerRevisionDigest: writerInternals.resolvePrWorkflowRevisionDigest,
	writerMergeBase: writerInternals.resolveMergeBase,
};

export function tempRoot(prefix = 'trigger-eval-receipt-followup-'): string {
	const root = canonicalMkdtemp(prefix);
	mkdirSync(join(root, '.git'), { recursive: true });
	tempDirs.push(root);
	return root;
}

export function rows() {
	return PR_REVIEW_TRIGGER_DEFINITIONS.map((definition, index) => ({
		trigger_id: definition.id,
		result: 'MATCHED' as const,
		evidence: `mandatory review focus for ${definition.id}`,
		source_batch_id: `micro-batch-${Math.floor(index / 8)}`,
		source_lane_id: `lane-${index}`,
	}));
}

function cleanRowText(
	mode: 'swarm-pr-review:base' | 'swarm-pr-review:micro',
	workflowLane: string,
): string {
	const header = mode === 'swarm-pr-review:base' ? BASE_HEADER : MICRO_HEADER;
	return `${header}\n[CLEAN] | ${workflowLane} | exact reviewed diff | no candidate survived the focused review`;
}

export async function recordLane(
	root: string,
	input: {
		batchId: string;
		laneId: string;
		workflowLane: string;
		ownedWorkflowLanes?: string[];
		mode: 'swarm-pr-review:base' | 'swarm-pr-review:micro';
		text: string;
		jobId?: string | null;
		workflowGeneration?: number;
		receipt?: unknown;
		resultOverrides?: Record<string, unknown>;
	},
): Promise<void> {
	const correlationId = `${input.batchId}-${input.laneId}-session`;
	await recordPendingDelegation(root, {
		correlationId,
		jobId: input.jobId ?? null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `${input.batchId}-call`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: input.batchId,
		laneId: input.laneId,
		mode: input.mode,
		prReviewLegacyTranscriptCompatibility: true,
		workflowLane: input.workflowLane,
		...(input.ownedWorkflowLanes
			? { ownedWorkflowLanes: input.ownedWorkflowLanes }
			: {}),
		...(input.workflowGeneration !== undefined
			? { workflowGeneration: input.workflowGeneration }
			: {}),
		workspace: {
			directory: root,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: REVIEW_SCOPE,
		},
	});
	const stored = storeLaneOutput(root, {
		batchId: input.batchId,
		laneId: input.laneId,
		agent: 'explorer',
		role: 'explorer',
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: input.mode,
		workflowLane: input.workflowLane,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		scope: REVIEW_SCOPE,
		source: 'collect_lane_results',
		text: input.text,
	});
	await appendDelegationTransition(root, correlationId, {
		status: 'completed',
		result: {
			text: input.text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
			...(input.receipt !== undefined
				? { prReviewResultReceipt: input.receipt }
				: {}),
			...(input.resultOverrides ?? {}),
		},
	});
}

export function buildReceipt(input: {
	workflowInstanceId: string;
	workflowRevision: number;
	batchId: string;
	laneId: string;
	workflowLane: string;
	ownedWorkflowLanes: string[];
	creditedLanes: string[];
	unresolved: { workflowLane: string; reason: string; detail: string }[];
	headSha: string;
	childSessionId: string;
}) {
	const envelope = {
		schemaVersion: 1 as const,
		outcome: (input.unresolved.length > 0 ? 'INCOMPLETE' : 'CLEAN') as
			| 'CLEAN'
			| 'INCOMPLETE',
		creditedLanes: input.creditedLanes,
		findings: [],
		cleanAttestations: input.creditedLanes.map((lane) => ({
			workflowLane: lane,
			coverageScope: 'exact reviewed diff for the family obligation',
			evidence:
				'receipt-settled clean attestation: the child submitted a structured envelope through submit_pr_review_result',
		})),
		unresolved: input.unresolved,
	};
	const receipt = {
		schemaVersion: 1 as const,
		mode: 'swarm-pr-review:micro' as const,
		workflowInstanceId: input.workflowInstanceId,
		workflowRevision: input.workflowRevision,
		batchId: input.batchId,
		laneId: input.laneId,
		workflowLane: input.workflowLane,
		ownedWorkflowLanes: input.ownedWorkflowLanes,
		baseSha: 'def456',
		headSha: input.headSha,
		dispatchRevisionDigest: REVISION_DIGEST,
		childSessionId: input.childSessionId,
		generation: 1,
		semanticEnvelopeDigest: prReviewLaneResultEnvelopeDigest(envelope),
		envelope,
	};
	const parsed = PrReviewResultReceiptSchema.safeParse(receipt);
	if (!parsed.success) {
		throw new Error(
			`fixture built an invalid receipt: ${JSON.stringify(parsed.error.issues)}`,
		);
	}
	return parsed.data;
}

export async function establishBoundReviewGate(
	root: string,
	options: { skipMicroIndexes: readonly number[] },
): Promise<{ workflowInstanceId: string; revision: number }> {
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 10,
		changedFiles: 1,
		hasSubmoduleChange: false,
	});
	writerInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	writerInternals.resolveMergeBase = () => 'def456';
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	gateInternals.resolvePrReviewDiffStatsAsync = async (dir, base, head) =>
		gateInternals.resolvePrReviewDiffStats(dir, base, head);
	await activatePrWorkflow(root, SESSION_ID, 'PR_REVIEW');
	await bindPrReviewBase(root, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: 'def456',
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
		await recordLane(root, {
			batchId: 'base-all',
			laneId: lane.laneId,
			workflowLane: lane.workflowLane,
			mode: 'swarm-pr-review:base',
			text: cleanRowText('swarm-pr-review:base', lane.workflowLane),
		});
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
	const skip = new Set(options.skipMicroIndexes);
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		if (skip.has(index)) continue;
		await recordLane(root, {
			batchId: `micro-batch-${Math.floor(index / 8)}`,
			laneId: `lane-${index}`,
			workflowLane,
			mode: 'swarm-pr-review:micro',
			text: cleanRowText('swarm-pr-review:micro', workflowLane),
		});
	}
	const state = await readPrWorkflowGateState(root, SESSION_ID);
	if (!state?.workflowInstanceId || typeof state.revision !== 'number') {
		throw new Error('fixture gate state lacks a workflow instance binding');
	}
	return {
		workflowInstanceId: state.workflowInstanceId,
		revision: state.revision,
	};
}

export function receiptPath(root: string, runId: string): string {
	return join(root, '.swarm', 'pr-review', runId, 'trigger-eval.json');
}

export function readDurableReceipt(root: string, runId: string) {
	return JSON.parse(readFileSync(receiptPath(root, runId), 'utf-8'));
}

export function writeTriggerEvalWithRows(
	root: string,
	runId: string,
	evalRows: ReturnType<typeof rows>,
) {
	return executeWritePrReviewTriggerEval(
		{
			run_id: runId,
			pr_head_sha: HEAD_SHA,
			base_sha: 'def456',
			base_ref: 'origin/main',
			rows: evalRows,
		},
		root,
		{ sessionID: SESSION_ID },
	);
}

export function writeTriggerEval(root: string, runId: string) {
	return writeTriggerEvalWithRows(root, runId, rows());
}

export function restoreFollowupFixtures(): void {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originalSeams.gateHead;
	gateInternals.resolveCurrentGitHeadAsync = originalSeams.gateHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = originalSeams.gateClean;
	gateInternals.resolveIsWorkingTreeCleanAsync = originalSeams.gateCleanAsync;
	gateInternals.resolvePrWorkflowRevisionDigest =
		originalSeams.gateRevisionDigest;
	gateInternals.resolvePrReviewDiffStats = originalSeams.gateDiffStats;
	gateInternals.resolvePrReviewDiffStatsAsync =
		originalSeams.gateDiffStatsAsync;
	writerInternals.resolvePrWorkflowRevisionDigest =
		originalSeams.writerRevisionDigest;
	writerInternals.resolveMergeBase = originalSeams.writerMergeBase;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
}
