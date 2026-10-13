// Issue #2906 review findings F-03 + F-04 — coverage AT the 128-batch
// capacity boundary:
//   F-03: `derivePrReviewPresentationOrder` must derive from the SAME pure
//   capacity prune the record guard applies inside its read-prune-append
//   transaction. Pre-fix the derive counted the unpruned window while the
//   guard counted the pruned one, and because the guard throws before
//   persistState the prune was never durable — every retry re-derived the
//   same divergent ordinal and the reviewer phase wedged (fail-closed
//   liveness dead end, contradicting the "safely re-dispatched" disclosure).
//   F-04: the capacity prune must RETAIN a reviewer batch that contributed
//   ORDER OBSERVATIONS even when the newer counterbalanced pass claimed every
//   item (its observations ride the #2906 agreement-only continuation); the
//   inventory-equality discharge cannot see label degradation to `single`.
//
// Both cases ride the filler-injection approach proven by
// tests/unit/tools/dispatch-lanes-counterbalance-production-2906.test.ts:
// record the real batches through the real gate APIs (so coherence receipts
// and artifacts are production-shaped), then inject non-contributing filler
// batches through the authoritative state writer to reach exactly
// MAX_WORKFLOW_BATCHES persisted validation batches.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	derivePrReviewPresentationOrder,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import { writeAuthoritativePrWorkflowState } from '../../helpers/pr-workflow-state-authority.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

const SESSION_ID = 'counterbalance-cap-2906';
const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const BASE_REF = 'origin/main';
const REVISION_DIGEST = 'counterbalance-cap-revision';
const REVIEW_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;
/** Canonical sorted candidate inventory produced by the base fixture. */
const INVENTORY = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);

const originalGateInternals = { ...gateInternals };
let directory = '';

beforeEach(() => {
	directory = canonicalMkdtemp('pr-gate-counterbalance-cap-2906-');
	mkdirSync(path.join(directory, '.git'), { recursive: true });
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
});

async function removeDirectory(): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fsp.rm(directory, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt >= 4 || (error as NodeJS.ErrnoException).code !== 'EBUSY')
				throw error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}

afterEach(async () => {
	Object.assign(gateInternals, originalGateInternals);
	gateInternals.resetTrackedStateCache();
	closeAllProjectDbs();
	await removeDirectory();
});

/** Same prerequisite chain as the counterbalance production suite. */
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
		await settleLane({
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
		await settleLane({
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

/** Record + artifact + completed transition for one settled lane. */
async function settleLane(args: {
	correlationId: string;
	callID: string;
	batchId: string;
	laneId: string;
	mode:
		| 'swarm-pr-review:base'
		| 'swarm-pr-review:micro'
		| 'swarm-pr-review:reviewer';
	workflowLane: string;
	text: string;
}): Promise<void> {
	await recordPendingDelegation(directory, {
		correlationId: args.correlationId,
		jobId: null,
		subagentSessionId: args.correlationId,
		parentSessionId: SESSION_ID,
		callID: args.callID,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: args.batchId,
		laneId: args.laneId,
		mode: args.mode,
		workflowLane: args.workflowLane,
		// Same mode-scoped default as the shared gate fixtures: discovery lanes
		// carry the legacy-transcript compatibility flag, reviewer lanes do not.
		...(args.mode === 'swarm-pr-review:base' ||
		args.mode === 'swarm-pr-review:micro'
			? { prReviewLegacyTranscriptCompatibility: true }
			: {}),
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
		agent: 'reviewer',
		role: 'reviewer',
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

/** Declare one reviewer batch owning `itemIds`; optionally expect an order. */
async function declareReviewerBatch(
	batchId: string,
	itemIds: readonly string[],
	expected?: 'A' | 'B',
): Promise<void> {
	await recordPrReviewValidationBatch(
		directory,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: `${batchId}-lane`,
				workflowLane: `${batchId}-lane`,
				reviewItemIds: [...itemIds],
			},
		],
		{
			batchId,
			prHeadSha: HEAD_SHA,
			...(expected ? { expectedPresentationOrder: expected } : {}),
		},
	);
}

/** Land a full-inventory reviewer artifact; `pass` flips C-2's severity. */
async function landReviewerRows(
	batchId: string,
	pass: 'A' | 'B',
): Promise<void> {
	const text = INVENTORY.map((itemId) =>
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
	await settleLane({
		correlationId: `${batchId}-lane`,
		callID: batchId,
		batchId,
		laneId: `${batchId}-lane`,
		mode: 'swarm-pr-review:reviewer',
		workflowLane: `${batchId}-lane`,
		text,
	});
}

/**
 * Inject `fillCount` non-contributing reviewer batches (no coherence entry, no
 * delegation record, one-item ownership that cannot match the six-item
 * inventory) before the newest real batch, reaching exactly
 * MAX_WORKFLOW_BATCHES persisted validation batches.
 */
async function injectFillerReviewerBatches(
	fillCount: number,
	newestBatchId: string,
): Promise<void> {
	const state = await readPrWorkflowGateState(directory, SESSION_ID);
	expect(state).not.toBeNull();
	const batches = state!.prReviewValidationBatches ?? [];
	const newest = batches.find((batch) => batch.batchId === newestBatchId);
	expect(newest, `reviewer batch ${newestBatchId}`).toBeDefined();
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
			Date.parse(newest!.validatedAt) - (fillCount - index) * 1_000,
		).toISOString(),
	}));
	const others = batches.filter((batch) => batch.batchId !== newestBatchId);
	await writeAuthoritativePrWorkflowState(directory, {
		...state!,
		prReviewValidationBatches: [...fillers, ...others, newest!],
	});
	gateInternals.resetTrackedStateCache();
}

async function validationBatchIds(): Promise<string[]> {
	gateInternals.resetTrackedStateCache();
	const state = await readPrWorkflowGateState(directory, SESSION_ID);
	return (state?.prReviewValidationBatches ?? []).map((batch) => batch.batchId);
}

describe('counterbalancing at the 128-batch capacity cap (issue #2906 F-03/F-04)', () => {
	test('F-03: derive and record count the same pruned window at the cap, so a parity-flipping prune cannot wedge the pass', async () => {
		await establishReviewPrerequisites();
		await declareReviewerBatch('cap-settled', INVENTORY, 'A');
		await landReviewerRows('cap-settled', 'A');
		await injectFillerReviewerBatches(
			gateInternals.MAX_WORKFLOW_BATCHES - 1,
			'cap-settled',
		);
		expect(await validationBatchIds()).toHaveLength(
			gateInternals.MAX_WORKFLOW_BATCHES,
		);

		// The preflight derivation must count the POST-prune window (the
		// prune drops all 127 inert fillers, leaving 1 reviewer batch ->
		// odd -> 'B'). Pre-F-03 it counted the unpruned 128 -> 'A'.
		expect(await derivePrReviewPresentationOrder(directory, SESSION_ID)).toBe(
			'B',
		);

		// The guard itself still fails closed on a genuinely wrong expected
		// order — and side-effect-free (nothing persisted, cap unchanged),
		// which is exactly why the pre-fix divergence wedged: the retry
		// re-derived the same 'A' from the still-unpruned state.
		await expect(
			declareReviewerBatch('cap-wrong', ['C-0'], 'A'),
		).rejects.toThrow(
			'presentation order derives as "B" but the dispatch prompt was built for "A"',
		);
		expect(await validationBatchIds()).toHaveLength(
			gateInternals.MAX_WORKFLOW_BATCHES,
		);

		// Re-dispatch with the derived order: the same pure prune runs inside
		// the record transaction, both sides count 1, and the record lands.
		// Pre-F-03 this was the permanent wedge.
		await declareReviewerBatch('cap-record', ['C-0'], 'B');
		expect(await validationBatchIds()).toEqual(['cap-settled', 'cap-record']);
	}, 60_000);

	test('F-04: the capacity prune retains the older counterbalanced pass that contributed order observations, so labels do not degrade to single', async () => {
		await establishReviewPrerequisites();
		await declareReviewerBatch('ret-pass-a', INVENTORY, 'A');
		await landReviewerRows('ret-pass-a', 'A');
		await declareReviewerBatch('ret-pass-b', INVENTORY, 'B');
		await landReviewerRows('ret-pass-b', 'B');
		await injectFillerReviewerBatches(
			gateInternals.MAX_WORKFLOW_BATCHES - 2,
			'ret-pass-b',
		);
		expect(await validationBatchIds()).toHaveLength(
			gateInternals.MAX_WORKFLOW_BATCHES,
		);

		// Post-prune the window is exactly the two counterbalanced passes
		// (even -> 'A'), and the record transaction persists that prune.
		expect(await derivePrReviewPresentationOrder(directory, SESSION_ID)).toBe(
			'A',
		);
		await declareReviewerBatch('ret-post-cap', ['C-0'], 'A');
		expect(await validationBatchIds()).toEqual([
			'ret-pass-a',
			'ret-pass-b',
			'ret-post-cap',
		]);

		// The older pass's receipt survived with its stamped order.
		const state = await readPrWorkflowGateState(directory, SESSION_ID);
		expect(
			state?.prReviewBatchCoherence?.['ret-pass-a']?.presentationOrder,
		).toBe('A');
		expect(
			state?.prReviewBatchCoherence?.['ret-pass-b']?.presentationOrder,
		).toBe('B');

		// The composed agreement labels read the RETAINED older pass: C-2
		// flipped HIGH -> CRITICAL across the passes, so 'disagree', and the
		// stable items 'agree'. Pre-F-04 the prune dropped 'ret-pass-a'
		// (claim-inert once 'ret-pass-b' claimed every item) and every label
		// silently degraded to 'single' — the inventory-equality discharge
		// could not see it.
		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			directory,
			SESSION_ID,
			'reviewer',
		);
		expect(composed.claims.get('C-2')?.orderAgreement).toBe('disagree');
		for (const itemId of INVENTORY.filter((id) => id !== 'C-2')) {
			expect(composed.claims.get(itemId)?.orderAgreement).toBe('agree');
		}
		// The adapter's exposed order-observation set names the older pass:
		// the survival filter's second input (F-04), distinct from claims.
		expect(composed.contributingBatchIds).toEqual(['ret-pass-b']);
		expect(composed.orderObservingBatchIds).toContain('ret-pass-a');
		expect(composed.orderObservingBatchIds).toContain('ret-pass-b');
	}, 60_000);
});
