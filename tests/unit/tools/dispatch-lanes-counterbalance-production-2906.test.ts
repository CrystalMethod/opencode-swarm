// Issue #2906 review finding F-05: the counterbalancing glue had no
// production-path test — the 2906 suites call applyPrWorkflowPromptContract,
// recordPrReviewValidationBatch, and the receipt encoders DIRECTLY, so a dropped
// wire inside executeDispatchLanesAsync left every suite green. This suite drives
// the real production entry points end-to-end and pins: two successive reviewer
// dispatches render assigned_item_ids canonical (A) then exactly reversed (B)
// with matching presentation_order lines and stamped coherence; at the disclosed
// >=128-batch boundary the PREFLIGHT applies the same pure capacity prune as the
// record guard (F-03) so a parity-flipping prune cannot wedge the two sides; a
// critic dispatch renders the composed order_unstable_item_ids; and the real
// collect path publishes a receipt footer naming the batch's presentationOrder.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	readDelegations,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_test_exports,
	_internals as dispatchInternals,
	executeCollectLaneResults,
	executeDispatchLanesAsync,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import { writeAuthoritativePrWorkflowState } from '../../helpers/pr-workflow-state-authority.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { waitFor } from '../../helpers/wait-for.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

const SESSION_ID = 'counterbalance-2906';
const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const BASE_REF = 'origin/main';
const REVISION_DIGEST = 'counterbalance-revision';
const REVIEW_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;
/** Canonical sorted candidate inventory produced by the base fixture. */
const INVENTORY = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);
/** Caller-declared order: deliberately neither sorted nor reversed. */
const SHUFFLED = ['C-3', 'C-0', 'C-5', 'C-1', 'C-4', 'C-2'];
const ORDER_LINE_A =
	'presentation_order: A (canonical; order candidate prose in this order)';
const ORDER_LINE_B =
	'presentation_order: B (reversed; order candidate prose in this order)';

const originalInternals = { ...dispatchInternals };
const originalGateInternals = { ...gateInternals };
let directory = '';
let createdSessions = 0;
let deliveredPrompts: string[] = [];
let transcripts = new Map<string, string>();

beforeEach(() => {
	directory = canonicalMkdtemp('dispatch-counterbalance-2906-');
	mkdirSync(path.join(directory, '.git'), { recursive: true });
	createdSessions = 0;
	deliveredPrompts = [];
	transcripts = new Map();
	_test_exports.resetDeliveredLaneOutputs();
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	dispatchInternals.resolveExactMergeBaseAsync = async () => BASE_SHA;
	dispatchInternals.getGeneratedAgentNames = () => ['reviewer', 'critic'];
	const ops: SessionOps = {
		create: mock(async () => ({
			data: { id: `cb-child-${++createdSessions}` },
			error: undefined,
		})),
		prompt: mock(async () => ({ data: undefined, error: undefined })),
		promptAsync: mock(async (args) => {
			deliveredPrompts.push(args.body.parts[0]?.text ?? '');
			return { data: undefined, error: undefined };
		}),
		status: mock(async () => ({
			data: Object.fromEntries(
				[...transcripts.keys()].map((session) => [session, { type: 'idle' }]),
			),
			error: undefined,
		})),
		messages: mock(async ({ path: sessionPath }) => ({
			data: transcripts.has(sessionPath.id)
				? [
						{
							info: { role: 'assistant' },
							parts: [{ type: 'text', text: transcripts.get(sessionPath.id) }],
						},
					]
				: [],
			error: undefined,
		})),
		delete: mock(async () => undefined),
	};
	dispatchInternals.getSessionOps = () => ops;
});

afterEach(async () => {
	Object.assign(dispatchInternals, originalInternals);
	Object.assign(gateInternals, originalGateInternals);
	gateInternals.resetTrackedStateCache();
	_test_exports.resetDeliveredLaneOutputs();
	closeAllProjectDbs();
	for (let attempt = 0; ; attempt++) {
		try {
			await fsp.rm(directory, { recursive: true, force: true });
			break;
		} catch (error) {
			if (attempt >= 4 || (error as NodeJS.ErrnoException).code !== 'EBUSY')
				throw error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
});

/** Record + artifact + completed transition for one settled discovery lane. */
async function recordSettledDiscoveryLane(args: {
	correlationId: string;
	callID: string;
	batchId: string;
	laneId: string;
	mode: 'swarm-pr-review:base' | 'swarm-pr-review:micro';
	workflowLane: string;
	text: string;
}): Promise<void> {
	await recordPendingDelegation(directory, {
		correlationId: args.correlationId,
		jobId: null,
		subagentSessionId: args.correlationId,
		parentSessionId: SESSION_ID,
		callID: args.callID,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: args.batchId,
		laneId: args.laneId,
		mode: args.mode,
		workflowLane: args.workflowLane,
		prReviewLegacyTranscriptCompatibility: true,
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: REVIEW_SCOPE,
		},
	});
	const stored = storeLaneOutput(directory, {
		batchId: args.batchId,
		laneId: args.laneId,
		agent: 'explorer',
		role: 'explorer',
		sessionId: args.correlationId,
		parentSessionId: SESSION_ID,
		mode: args.mode,
		workflowLane: args.workflowLane,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		scope: REVIEW_SCOPE,
		source: 'collect_lane_results',
		text: args.text,
	});
	await appendDelegationTransition(directory, args.correlationId, {
		status: 'completed',
		result: {
			text: args.text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
	});
}

/** Same prerequisite chain as the council mechanical-dispatch suite. */
async function establishReviewPrerequisites(): Promise<void> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
	await bindPrReviewBase(directory, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: BASE_REF,
		baseSha: BASE_SHA,
	});
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(directory, SESSION_ID, baseLanes, {
		batchId: 'base-all',
		prHeadSha: HEAD_SHA,
		prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
	const baseHeader =
		'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';
	for (const [index, lane] of baseLanes.entries()) {
		await recordSettledDiscoveryLane({
			correlationId: `base-${index}`,
			callID: `call-${index}`,
			batchId: 'base-all',
			laneId: lane.laneId,
			mode: 'swarm-pr-review:base',
			workflowLane: lane.workflowLane,
			text: `${baseHeader}\nC-${index} | ${lane.workflowLane} | LOW | correctness | file.ts:1 | claim | evidence | impact | LOW | ORDINARY | `,
		});
	}
	const microHeader =
		'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';
	const triggerRows: Array<Record<string, string>> = [];
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		const batchId = `micro-${index}`;
		const laneId = `micro-lane-${index}`;
		await recordSettledDiscoveryLane({
			correlationId: `micro-session-${index}`,
			callID: batchId,
			batchId,
			laneId,
			mode: 'swarm-pr-review:micro',
			workflowLane,
			text: `${microHeader}\n[CLEAN] | ${workflowLane} | exact reviewed diff | no finding after focused invariant review`,
		});
		triggerRows.push({
			trigger_id: workflowLane,
			result: 'MATCHED',
			evidence: `Fixture evidence for ${workflowLane}`,
			source_batch_id: batchId,
			source_lane_id: laneId,
		});
	}
	const triggerRelative = path.join('pr-review', 'run', 'trigger-eval.json');
	const triggerAbsolute = path.join(directory, '.swarm', triggerRelative);
	await fsp.mkdir(path.dirname(triggerAbsolute), { recursive: true });
	await fsp.writeFile(
		triggerAbsolute,
		JSON.stringify({ rows: triggerRows }),
		'utf-8',
	);
	await markPrReviewTriggerEvaluationComplete(
		directory,
		SESSION_ID,
		'run',
		triggerRelative,
	);
}

/**
 * One full-coverage reviewer lane per pass, declared in the shuffled order so
 * pass A's canonical sort and pass B's exact reverse are both observable.
 */
async function dispatchReviewerBatch(batchId: string) {
	const result = await executeDispatchLanesAsync(
		{
			mode: 'swarm-pr-review:reviewer',
			pr_head_sha: HEAD_SHA,
			base_sha: BASE_SHA,
			base_ref: BASE_REF,
			batch_id: batchId,
			lanes: [
				{
					id: `${batchId}-lane`,
					agent: 'reviewer',
					prompt: 'Classify every assigned candidate.',
					workflow_lane: `${batchId}-lane`,
					review_item_ids: [...SHUFFLED],
				},
			],
		},
		directory,
		{ sessionID: SESSION_ID },
	);
	expect(result.success, result.message).toBe(true);
	return result;
}

/** Six [REVIEWED] rows; pass B flips C-2's severity HIGH -> CRITICAL. */
function reviewedRows(pass: 'A' | 'B'): string {
	return INVENTORY.map((itemId) =>
		[
			'[REVIEWED]',
			itemId,
			'CONFIRMED',
			'STRUCTURALLY_PROVEN',
			itemId === 'C-2' && pass === 'B' ? 'CRITICAL' : 'HIGH',
			'YES',
			'src/a.ts:1',
			'direct code evidence at the exact location',
			'traced downstream impact context',
			'reviewer root cause analysis',
			'ORDINARY',
			'',
		].join(' | '),
	).join('\n');
}

/** Settle one dispatched reviewer batch through the real collect path. */
async function settleViaCollect(batchId: string, pass: 'A' | 'B') {
	const record = readDelegations(directory).find(
		(candidate) => candidate.batchId === batchId,
	);
	expect(record?.subagentSessionId, `lane record for ${batchId}`).toBeTruthy();
	transcripts.set(record!.subagentSessionId!, reviewedRows(pass));
	const collected = await executeCollectLaneResults(
		{ batch_id: batchId, wait: false },
		directory,
		{ sessionID: SESSION_ID },
	);
	expect(collected.success, JSON.stringify(collected.lane_results)).toBe(true);
	expect(collected.lane_results[0]?.status).toBe('completed');
	return collected;
}

async function stampedPresentationOrder(batchId: string) {
	const state = await readPrWorkflowGateState(directory, SESSION_ID);
	return state?.prReviewBatchCoherence?.[batchId]?.presentationOrder;
}

/**
 * Arrange the disclosed >=128-batch capacity condition: `fillCount`
 * non-contributing reviewer batches before the settled batch, so the persisted
 * window holds an even 128 while the capacity prune drops all 127 fillers and
 * leaves a 1-batch window — the parity flip both the preflight derivation and
 * the record guard must now count through the same pure prune (F-03).
 */
async function injectFillerReviewerBatches(
	fillCount: number,
	settledBatchId: string,
): Promise<void> {
	const state = await readPrWorkflowGateState(directory, SESSION_ID);
	expect(state).not.toBeNull();
	const batches = state!.prReviewValidationBatches ?? [];
	const settled = batches.find((batch) => batch.batchId === settledBatchId);
	expect(settled, `settled reviewer batch ${settledBatchId}`).toBeDefined();
	const fillers = Array.from({ length: fillCount }, (_, index) => ({
		batchId: `filler-batch-${index}`,
		phase: 'reviewer' as const,
		lanes: [
			{
				laneId: `filler-lane-${index}`,
				workflowLane: `filler-window-${index}`,
				reviewItemIds: ['C-0'],
			},
		],
		validatedAt: new Date(
			Date.parse(settled!.validatedAt) - (fillCount - index) * 1_000,
		).toISOString(),
	}));
	const others = batches.filter((batch) => batch.batchId !== settledBatchId);
	await writeAuthoritativePrWorkflowState(directory, {
		...state!,
		prReviewValidationBatches: [...fillers, ...others, settled!],
	});
	gateInternals.resetTrackedStateCache();
}

async function awaitPromptCount(count: number): Promise<void> {
	await waitFor(
		() => deliveredPrompts.length >= count,
		5_000,
		`delivery of ${count} lane prompts`,
	);
}

describe('dispatch_lanes_async PR_REVIEW counterbalancing (issue #2906 production path)', () => {
	test('two successive reviewer passes render canonical then reversed ids, stamp matching receipts, and footer the pass order', async () => {
		await establishReviewPrerequisites();

		const passA = await dispatchReviewerBatch('rev-pass-a');
		expect(passA.pending).toBe(1);
		await awaitPromptCount(1);
		expect(deliveredPrompts[0]).toContain(
			`assigned_item_ids: ${INVENTORY.join(', ')}`,
		);
		expect(deliveredPrompts[0]).toContain(ORDER_LINE_A);
		expect(deliveredPrompts[0]).not.toContain(SHUFFLED.join(', '));
		expect(await stampedPresentationOrder('rev-pass-a')).toBe('A');

		await dispatchReviewerBatch('rev-pass-b');
		await awaitPromptCount(2);
		expect(deliveredPrompts[1]).toContain(
			`assigned_item_ids: ${[...INVENTORY].reverse().join(', ')}`,
		);
		expect(deliveredPrompts[1]).toContain(ORDER_LINE_B);
		expect(await stampedPresentationOrder('rev-pass-b')).toBe('B');

		const collected = await settleViaCollect('rev-pass-a', 'A');
		const output = collected.lane_results[0]?.output ?? '';
		expect(output).toContain('[PR_REVIEW_COLLECTION_RECEIPT_V1]');
		expect(output).toContain('"presentationOrder":"A"');
	}, 60_000);

	test('at the >=128-batch cap the preflight derivation applies the same pure prune as the record guard, so a parity-flipping prune cannot wedge the dispatch', async () => {
		await establishReviewPrerequisites();
		await dispatchReviewerBatch('rev-settled');
		await settleViaCollect('rev-settled', 'A');
		await injectFillerReviewerBatches(127, 'rev-settled');

		const atCap = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:reviewer',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: BASE_REF,
				batch_id: 'rev-at-cap',
				lanes: [
					{
						id: 'rev-at-cap-lane',
						agent: 'reviewer',
						prompt: 'Classify every assigned candidate.',
						workflow_lane: 'rev-at-cap-lane',
						review_item_ids: ['C-0'],
					},
				],
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		// Pre-F-03 this failed closed forever: the preflight counted the
		// UNPRUNED window (128 reviewer batches -> 'A') while the record guard
		// counted the pruned one (1 retained -> 'B'), and the guard throws
		// before persistState, so every retry re-derived the same divergent
		// 'A'. With the derivation applying the same pure prune, the dispatch
		// succeeds and a retry would re-derive the same 'B'.
		expect(atCap.success, atCap.message).toBe(true);
		await awaitPromptCount(2);
		expect(deliveredPrompts[1]).toContain(ORDER_LINE_B);
		expect(await stampedPresentationOrder('rev-at-cap')).toBe('B');
		// The prune became durable in the same transaction as the append: the
		// 127 inert fillers are gone and the retained window is exactly the
		// settled batch plus the new record.
		const state = await readPrWorkflowGateState(directory, SESSION_ID);
		expect(
			(state?.prReviewValidationBatches ?? []).map((batch) => batch.batchId),
		).toEqual(['rev-settled', 'rev-at-cap']);
	}, 60_000);

	test('critic dispatch renders order_unstable_item_ids from the composed cross-pass verdicts', async () => {
		await establishReviewPrerequisites();
		await dispatchReviewerBatch('rev-pass-a');
		await settleViaCollect('rev-pass-a', 'A');
		await dispatchReviewerBatch('rev-pass-b');
		await settleViaCollect('rev-pass-b', 'B');

		const critic = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:critic',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: BASE_REF,
				batch_id: 'critic-pass-1',
				lanes: [
					{
						id: 'critic-lane',
						agent: 'critic',
						prompt: 'Challenge every assigned reviewer verdict.',
						workflow_lane: 'critic-lane',
						review_item_ids: [...SHUFFLED],
					},
				],
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(critic.success, critic.message).toBe(true);
		await awaitPromptCount(3);
		const unstableLine = deliveredPrompts[2].match(
			/^order_unstable_item_ids: (.+)$/m,
		);
		expect(unstableLine).not.toBeNull();
		// Only C-2 flipped across the counterbalanced passes; the five agreeing
		// items must not ride the critic's priority line.
		expect(unstableLine?.[1]).toBe('C-2');
	}, 60_000);
});
