import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import {
	encodePrReviewWorkflowBinding,
	PrReviewResultReceiptSchema,
	prReviewLaneResultEnvelopeDigest,
} from '../../../src/background/pr-review-contract';
import { prReviewReceiptHasCoverageDegradations } from '../../../src/background/pr-review-trigger-receipt-reader';
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
import { allowedPrReviewReportVerdicts } from '../../../src/pr-review/completion';
import {
	executeWritePrReviewTriggerEval,
	PR_REVIEW_TRIGGER_DEFINITIONS,
	_internals as writerInternals,
} from '../../../src/tools/write-pr-review-trigger-eval';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Issue #3094 frozen acceptance checks: a MATCHED micro family settled SOLELY
// by a schema-valid, exact-bound structured receipt (submit_pr_review_result)
// with a zero-row retained transcript artifact is COVERED, not degraded.
// Pre-fix, write_pr_review_trigger_eval judged coverage from the artifact TEXT
// alone, so such families got the spurious "no covered candidate or clean row"
// degradation on the durable receipt — forbidding APPROVE downstream. An
// identity-mismatched receipt must stay fail-closed, and receipt settlement is
// disclosed as its own distinct class (receipt_covered_families).

const tempDirs: string[] = [];
const SESSION_ID = 'trigger-eval-receipt-coverage-session';
const HEAD_SHA = 'abc123';
// 64-hex on purpose: the receipt schema constrains dispatchRevisionDigest to
// /^[0-9a-f]{64}$/i and must carry the SAME digest the stubs derive (exact-bound).
const REVISION_DIGEST =
	'5f2a9c0b81d34e76a0c2f1b98d7e6a53c49018f2b6d3e7a9410cd58b2f7e6a31';
const REVIEW_SCOPE = `complete PR diff def456...${HEAD_SHA}`;
// The #3094 shape: a completed lane whose retained artifact text carries zero
// [CANDIDATE]/[CLEAN] protocol rows — only a bare meta-remark.
const RECEIPT_ONLY_TEXT =
	'The structured result was already submitted via submit_pr_review_result; this transcript contains no protocol rows.';
const RECEIPT_LANE_INDEX = 2;
const MISMATCH_LANE_INDEX = 3;
const RECEIPT_FAMILY = PR_REVIEW_REQUIRED_MICRO_LANE_IDS[RECEIPT_LANE_INDEX];
const RECEIPT_BATCH_ID = `micro-batch-${Math.floor(RECEIPT_LANE_INDEX / 8)}`;
const RECEIPT_LANE_ID = `lane-${RECEIPT_LANE_INDEX}`;
// Valid hex per the receipt SHA schema but NOT this run's head.
const MISMATCHED_HEAD_SHA = 'ffff0000000000000000000000000000000000000';
const BASE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';
const MICRO_HEADER =
	'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';

const original = {
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

function tempRoot(): string {
	const root = canonicalMkdtemp('trigger-eval-receipt-coverage-');
	mkdirSync(join(root, '.git'), { recursive: true });
	tempDirs.push(root);
	return root;
}

function rows() {
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

/** Record one COMPLETED lane with a provenance-exact retained artifact. The
 * optional `receipt`/workflow binding inputs build the #3094 textless shape. */
async function recordLane(
	root: string,
	input: {
		batchId: string;
		laneId: string;
		workflowLane: string;
		mode: 'swarm-pr-review:base' | 'swarm-pr-review:micro';
		text: string;
		jobId?: string | null;
		workflowGeneration?: number;
		receipt?: unknown;
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
		},
	});
}

function buildFamilyReceipt(input: {
	workflowInstanceId: string;
	workflowRevision: number;
	batchId: string;
	laneId: string;
	family: string;
	headSha: string;
	childSessionId: string;
}) {
	const envelope = {
		schemaVersion: 1 as const,
		outcome: 'CLEAN' as const,
		creditedLanes: [input.family],
		findings: [],
		cleanAttestations: [
			{
				workflowLane: input.family,
				coverageScope: 'exact reviewed diff for the family obligation',
				evidence:
					'receipt-settled clean attestation: the child submitted a structured CLEAN envelope through submit_pr_review_result',
			},
		],
		unresolved: [],
	};
	const receipt = {
		schemaVersion: 1 as const,
		mode: 'swarm-pr-review:micro' as const,
		workflowInstanceId: input.workflowInstanceId,
		workflowRevision: input.workflowRevision,
		batchId: input.batchId,
		laneId: input.laneId,
		workflowLane: input.family,
		ownedWorkflowLanes: [input.family],
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

/** The #3094 lane shape: COMPLETED, retained provenance-exact artifact whose
 * text has zero protocol rows, settled by a structured result receipt that is
 * exact-bound to the live gate workflow (jobId encoding + generation). */
async function recordReceiptSettledTextlessLane(
	root: string,
	binding: { workflowInstanceId: string; revision: number },
	laneIndex: number,
	options: { receiptHeadSha?: string } = {},
): Promise<void> {
	const family = PR_REVIEW_REQUIRED_MICRO_LANE_IDS[laneIndex];
	const batchId = `micro-batch-${Math.floor(laneIndex / 8)}`;
	const laneId = `lane-${laneIndex}`;
	const correlationId = `${batchId}-${laneId}-session`;
	await recordLane(root, {
		batchId,
		laneId,
		workflowLane: family,
		mode: 'swarm-pr-review:micro',
		text: RECEIPT_ONLY_TEXT,
		jobId: encodePrReviewWorkflowBinding(binding.workflowInstanceId),
		workflowGeneration: binding.revision,
		receipt: buildFamilyReceipt({
			workflowInstanceId: binding.workflowInstanceId,
			workflowRevision: binding.revision,
			batchId,
			laneId,
			family,
			headSha: options.receiptHeadSha ?? HEAD_SHA,
			childSessionId: correlationId,
		}),
	});
}

async function establishBoundReviewGate(
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

function readDurableReceipt(root: string, runId: string) {
	// validateSwarmPath resolves every runtime artifact under <root>/.swarm/.
	return JSON.parse(
		readFileSync(
			join(root, '.swarm', 'pr-review', runId, 'trigger-eval.json'),
			'utf-8',
		),
	);
}

function writeTriggerEval(root: string, runId: string) {
	return executeWritePrReviewTriggerEval(
		{
			run_id: runId,
			pr_head_sha: HEAD_SHA,
			base_sha: 'def456',
			base_ref: 'origin/main',
			rows: rows(),
		},
		root,
		{ sessionID: SESSION_ID },
	);
}

function uncoveredDegradationEntries(
	receipt: { coverage_degradations?: { trigger_id: string; reason: string }[] },
	triggerId: string,
) {
	return (receipt.coverage_degradations ?? []).filter(
		(entry) =>
			entry.trigger_id === triggerId &&
			entry.reason.includes('no covered candidate or clean row'),
	);
}

afterEach(() => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = original.gateHead;
	gateInternals.resolveCurrentGitHeadAsync = original.gateHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = original.gateClean;
	gateInternals.resolveIsWorkingTreeCleanAsync = original.gateCleanAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = original.gateRevisionDigest;
	gateInternals.resolvePrReviewDiffStats = original.gateDiffStats;
	gateInternals.resolvePrReviewDiffStatsAsync = original.gateDiffStatsAsync;
	writerInternals.resolvePrWorkflowRevisionDigest =
		original.writerRevisionDigest;
	writerInternals.resolveMergeBase = original.writerMergeBase;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('write_pr_review_trigger_eval receipt-settled coverage (issue #3094)', () => {
	test('receipt-only settled family records no coverage degradation', async () => {
		const root = tempRoot();
		const binding = await establishBoundReviewGate(root, {
			skipMicroIndexes: [RECEIPT_LANE_INDEX],
		});
		await recordReceiptSettledTextlessLane(root, binding, RECEIPT_LANE_INDEX);
		const result = JSON.parse(
			await writeTriggerEval(root, 'receipt-covered-1'),
		);
		expect(result.success).toBe(true);
		expect(result.coverage_degradation_count).toBe(0);
		const receipt = readDurableReceipt(root, 'receipt-covered-1');
		const familyEntries = (receipt.coverage_degradations ?? []).filter(
			(entry: { trigger_id: string }) => entry.trigger_id === RECEIPT_FAMILY,
		);
		expect(familyEntries).toEqual([]);
		// Every other family settled with [CLEAN]-row text lanes: fully clean run.
		expect(receipt.coverage_degradations).toEqual([]);
	});

	test('receipt-covered family disclosed as distinct class', async () => {
		const root = tempRoot();
		const binding = await establishBoundReviewGate(root, {
			skipMicroIndexes: [RECEIPT_LANE_INDEX],
		});
		await recordReceiptSettledTextlessLane(root, binding, RECEIPT_LANE_INDEX);
		const result = JSON.parse(
			await writeTriggerEval(root, 'receipt-covered-2'),
		);
		expect(result.success).toBe(true);
		const receipt = readDurableReceipt(root, 'receipt-covered-2');
		const covered: unknown = receipt.receipt_covered_families;
		expect(Array.isArray(covered)).toBe(true);
		const entries = covered as Array<Record<string, unknown>>;
		const familyEntry = entries.find(
			(entry) => entry.trigger_id === RECEIPT_FAMILY,
		);
		expect(familyEntry).toMatchObject({
			trigger_id: RECEIPT_FAMILY,
			source_batch_id: RECEIPT_BATCH_ID,
			source_lane_id: RECEIPT_LANE_ID,
		});
		// Disclosed as covered, never as degraded.
		expect(uncoveredDegradationEntries(receipt, RECEIPT_FAMILY)).toEqual([]);
		// Text-covered families must stay OUT of the receipt-covered class.
		const textFamily = PR_REVIEW_REQUIRED_MICRO_LANE_IDS[0];
		expect(entries.some((entry) => entry.trigger_id === textFamily)).toBe(
			false,
		);
	});

	test('identity-mismatched receipt does not credit coverage', async () => {
		const root = tempRoot();
		const binding = await establishBoundReviewGate(root, {
			skipMicroIndexes: [RECEIPT_LANE_INDEX, MISMATCH_LANE_INDEX],
		});
		// Lane 2: receipt headSha does not match this run's head — the exact-bound
		// contract must reject it and keep the degradation.
		await recordReceiptSettledTextlessLane(root, binding, RECEIPT_LANE_INDEX, {
			receiptHeadSha: MISMATCHED_HEAD_SHA,
		});
		// Lane 3: a valid exact-bound receipt crediting its own family.
		await recordReceiptSettledTextlessLane(root, binding, MISMATCH_LANE_INDEX);
		const result = JSON.parse(
			await writeTriggerEval(root, 'receipt-mismatch-1'),
		);
		expect(result.success).toBe(true);
		const receipt = readDurableReceipt(root, 'receipt-mismatch-1');
		const validFamily = PR_REVIEW_REQUIRED_MICRO_LANE_IDS[MISMATCH_LANE_INDEX];
		// The valid receipt credits its family: no degradation for it.
		expect(uncoveredDegradationEntries(receipt, validFamily)).toEqual([]);
		// The mismatched receipt must NOT silently credit coverage.
		expect(uncoveredDegradationEntries(receipt, RECEIPT_FAMILY)).toHaveLength(
			1,
		);
	});

	test('fully receipt-settled run leaves APPROVE reachable', async () => {
		const root = tempRoot();
		const binding = await establishBoundReviewGate(root, {
			skipMicroIndexes: PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map(
				(_, index) => index,
			),
		});
		for (const [index] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
			await recordReceiptSettledTextlessLane(root, binding, index);
		}
		const runId = 'receipt-full-1';
		const result = JSON.parse(await writeTriggerEval(root, runId));
		expect(result.success).toBe(true);
		expect(result.coverage_degradation_count).toBe(0);
		const receipt = readDurableReceipt(root, runId);
		expect(receipt.coverage_degradations).toEqual([]);
		expect(Array.isArray(receipt.receipt_covered_families)).toBe(true);
		expect(receipt.receipt_covered_families).toHaveLength(
			PR_REVIEW_REQUIRED_MICRO_LANE_IDS.length,
		);
		// Verdict linkage, deterministically: the durable receipt the gate reads
		// (forward-slash relative path, as the writer stores it) discloses zero
		// degradations, keeping APPROVE in a COMPLETE verdict matrix.
		const hasDegradations = prReviewReceiptHasCoverageDegradations(
			root,
			`pr-review/${runId}/trigger-eval.json`,
		);
		expect(hasDegradations).toBe(false);
		expect(
			allowedPrReviewReportVerdicts('COMPLETE', [], {
				disclosedCoverageDegradation: hasDegradations,
			}),
		).toContain('APPROVE');
	});
});
