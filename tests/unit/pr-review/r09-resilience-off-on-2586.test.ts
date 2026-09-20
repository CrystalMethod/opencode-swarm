import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CANDIDATE_HEADERS } from '../../../src/background/candidate-contract.js';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	claimTerminalResult,
	findByBatchId,
	findByCorrelationId,
} from '../../../src/background/pending-delegations.js';
import type { PrReviewInlineTriggerRow } from '../../../src/background/pr-review-trigger-contract.js';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { _internals as dispatchInternals } from '../../../src/tools/dispatch-lanes.js';
import { _internals as triggerInternals } from '../../../src/tools/write-pr-review-trigger-eval.js';
import { createIssue2469HostClient } from '../../helpers/issue-2469-registered-host.js';
import { bootKnowledgeHost } from '../../helpers/knowledge-real-host.js';
import {
	artifactRecord,
	reviewedRow,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

/**
 * Issue #2586 AC2 (R09): resilience off/on. The legacy one-wave base path and
 * the enabled staged canary/fanout path BOTH finish a clean journey
 * (complete_pr_workflow -> COMPLETE, zero live lanes). Retry touches
 * unresolved work only — a terminally failed lane is re-dispatched through a
 * NEW partial-retry batch while every already-successful producer stays
 * un-relaunched and byte-identical in the durable store — and per-run
 * identity survives the r13 restart. r03/r13 seams (no mock.module).
 */
const SESSION_ID = 'r09-resilience-off-on';
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const REVISION_DIGEST = 'e'.repeat(64);
const RUN_ID = 'r09-resilience-run';
/** Tier-M consolidated all-six partition: 3 lanes x 2 dimensions. */
const CONSOLIDATED = [
	PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 2),
	PR_REVIEW_BASE_DIMENSION_IDS.slice(2, 4),
	PR_REVIEW_BASE_DIMENSION_IDS.slice(4),
];
/** The canary dimension and the fanout partition of the other five. */
const CANARY_DIM = PR_REVIEW_BASE_DIMENSION_IDS[0]!;
const FANOUT = [
	PR_REVIEW_BASE_DIMENSION_IDS.slice(1, 3),
	PR_REVIEW_BASE_DIMENSION_IDS.slice(3),
];
// Shallow seam snapshots; afterEach restores every key so overrides cannot leak.
const originalGate = { ...gateInternals };
const originalDispatch = { ...dispatchInternals };
const originalTrigger = { ...triggerInternals };
let directory = '';
let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>>;
let nextChild = 0;
let deliveredPrompts = new Map<string, string>();
let resilienceEnabled = false;

type Parsed = Record<string, unknown> & { success: boolean };
type CompletionReport = Parsed & {
	terminal_report: { covered_dimensions: string[]; allowed_verdicts: string[] };
};
/** r02-style indirection: every tool call returns one bounded JSON payload. */
async function run(
	name: string,
	args: unknown,
	sessionID = SESSION_ID,
): Promise<Parsed> {
	return JSON.parse(
		String(await plugin.tool[name].execute(args, { directory, sessionID })),
	) as Parsed;
}
function promptField(prompt: string, name: string): string {
	const value = prompt.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1]?.trim();
	if (!value) throw new Error(`missing ${name} in rendered child prompt`);
	return value;
}
/** Terminal typed lane failure: claim status 'error', no receipt, no output. */
async function failLane(record: ReturnType<typeof findByBatchId>[number]) {
	const terminal = await claimTerminalResult(directory, record.correlationId, {
		eventId: `r09-error-${record.correlationId}`,
		status: 'error',
		recordedAt: 2,
		result: {
			error: 'synthetic terminal failure',
			chars: 0,
			truncated: false,
			digest: 'd'.repeat(64),
		},
	});
	expect(terminal?.disposition).toBe('claimed');
	expect(findByCorrelationId(directory, record.subagentSessionId)?.status).toBe(
		'error',
	);
}
async function finishLane(record: ReturnType<typeof findByBatchId>[number]) {
	const header =
		(record.mode === 'swarm-pr-review:micro' && CANDIDATE_HEADERS.micro_lane) ||
		(record.mode === 'swarm-pr-review:base' &&
			CANDIDATE_HEADERS.base_explorer) ||
		null;
	const text = header
		? `${header}\n[CLEAN] | ${record.workflowLane} | exact bound diff | registered child found no actionable defect`
		: reviewedRow('CLEAN-REVIEW', 'DISPROVED', 'NONE');
	const stored = storeLaneOutput(directory, {
		batchId: record.batchId!,
		laneId: record.laneId!,
		agent: record.swarmPrefixedAgent,
		role: record.normalizedAgent,
		sessionId: record.subagentSessionId,
		parentSessionId: SESSION_ID,
		mode: record.mode,
		workflowLane: record.workflowLane,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		scope: record.workspace?.scope ?? undefined,
		source: 'collect_lane_results',
		text,
	});
	const terminal = await claimTerminalResult(directory, record.correlationId, {
		eventId: `r09-${record.correlationId}`,
		status: 'completed',
		recordedAt: 1,
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			...(stored.ref ? { outputRef: stored.ref } : {}),
		},
	});
	expect(terminal?.disposition).toBe('claimed');
}
async function submitAndFinish(
	batchId: string,
	skip?: (record: ReturnType<typeof findByBatchId>[number]) => boolean,
): Promise<void> {
	for (const record of findByBatchId(directory, batchId, SESSION_ID)) {
		if (skip?.(record)) continue;
		const prompt = deliveredPrompts.get(record.subagentSessionId);
		if (!prompt) throw new Error('missing rendered child prompt');
		const owned = prompt
			.match(/^owned_workflow_lanes: (.+?) —/m)?.[1]
			?.split(',')
			.map((lane) => lane.trim());
		const envelopeLanes = owned ?? [promptField(prompt, 'workflow_lane')];
		const result = await run(
			'submit_pr_review_result',
			{
				schemaVersion: 1,
				batchId: promptField(prompt, 'batch_id'),
				laneId: promptField(prompt, 'lane_id'),
				revisionDigest: promptField(prompt, 'revision_digest'),
				result: {
					schemaVersion: 1,
					outcome: 'CLEAN',
					creditedLanes: envelopeLanes,
					findings: [],
					cleanAttestations: envelopeLanes.map((workflowLane) => ({
						coverageScope: `Complete ${workflowLane} surface on the bound diff.`,
						evidence: 'Registered child found no actionable defect.',
						workflowLane,
					})),
					unresolved: [],
				},
			},
			record.subagentSessionId,
		);
		expect(result).toMatchObject({ success: true, status: 'recorded' });
		await finishLane(record);
	}
}
async function dispatch(
	batchId: string,
	mode: 'swarm-pr-review:base' | 'swarm-pr-review:micro',
	workflowLanes: readonly (string | readonly string[])[],
	options: {
		triggerEvaluation?: PrReviewInlineTriggerRow[];
		wave?: { stage: 'canary' | 'fanout'; attempt: 0 | 1 | 2 };
		expectStagedRefusal?: boolean;
	} = {},
): Promise<void> {
	const lanes = workflowLanes.map((entry, index) => {
		const owned = typeof entry === 'string' ? [entry] : [...entry];
		return {
			id: `${mode.endsWith(':base') ? 'base' : 'micro'}-${index}`,
			agent: 'explorer',
			prompt: `Review ${owned.join(', ')} on the exact bound diff.`,
			workflow_lane: owned[0]!,
			...(owned.length > 1 ? { owned_workflow_lanes: owned } : {}),
		};
	});
	const result = await run('dispatch_lanes_async', {
		batch_id: batchId,
		mode,
		pr_head_sha: HEAD_SHA,
		base_sha: BASE_SHA,
		base_ref: 'origin/main',
		max_concurrent: lanes.length,
		...(options.triggerEvaluation
			? { trigger_evaluation: options.triggerEvaluation }
			: {}),
		...(options.wave
			? {
					pr_review_wave_stage: options.wave.stage,
					pr_review_wave_attempt: options.wave.attempt,
				}
			: {}),
		lanes,
	});
	if (options.expectStagedRefusal) {
		expect(result.success).toBe(false);
		expect(JSON.stringify(result)).toContain('requires canary-first');
	} else {
		expect(result).toMatchObject({ success: true, pending: lanes.length });
	}
}
/** Journey tail: 11 micro lanes, trigger ledger, findings ladder, completion. */
async function finishJourney(): Promise<CompletionReport> {
	const inlineTriggers: PrReviewInlineTriggerRow[] =
		PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map((triggerId) => ({
			trigger_id: triggerId,
			result: 'MATCHED',
			evidence: `The bound diff requires focused review for ${triggerId}.`,
		}));
	const triggerRows: Array<Record<string, string>> = [];
	for (const [offset, lane] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		const batchId = `r09-micro-${offset}`;
		await dispatch(
			batchId,
			'swarm-pr-review:micro',
			[lane],
			offset === 0 ? { triggerEvaluation: inlineTriggers } : {},
		);
		await submitAndFinish(batchId);
		for (const record of findByBatchId(directory, batchId, SESSION_ID)) {
			triggerRows.push({
				trigger_id: record.workflowLane!,
				result: 'MATCHED',
				evidence: `Registered micro receipt covers ${record.workflowLane}.`,
				source_batch_id: batchId,
				source_lane_id: record.laneId!,
			});
		}
	}
	const trigger = await run('write_pr_review_trigger_eval', {
		run_id: RUN_ID,
		pr_head_sha: HEAD_SHA,
		base_ref: 'origin/main',
		base_sha: BASE_SHA,
		rows: triggerRows,
	});
	expect(trigger).toMatchObject({ success: true, matched_count: 11 });
	const write = async (
		boundary: 'post_explorer' | 'post_reviewer' | 'post_critic',
		status: 'PENDING' | 'DISPROVED',
		nextAction: 'route_to_reviewer' | 'suppress_with_reason',
	): Promise<void> => {
		const artifact = await run('write_pr_review_artifact', {
			kind: 'findings',
			run_id: RUN_ID,
			pr_head_sha: HEAD_SHA,
			boundary,
			records: [artifactRecord('CLEAN-REVIEW', status, nextAction, 'NONE')],
		});
		expect(artifact.success).toBe(true);
	};
	await write('post_explorer', 'PENDING', 'route_to_reviewer');
	const reviewer = await run('dispatch_lanes_async', {
		batch_id: 'r09-reviewer',
		mode: 'swarm-pr-review:reviewer',
		pr_head_sha: HEAD_SHA,
		base_sha: BASE_SHA,
		base_ref: 'origin/main',
		max_concurrent: 1,
		lanes: [
			{
				id: 'r09-reviewer-lane',
				agent: 'reviewer',
				prompt: 'Classify the clean-review sentinel.',
				workflow_lane: 'r09-reviewer-lane',
				review_item_ids: ['CLEAN-REVIEW'],
			},
		],
	});
	expect(reviewer.success).toBe(true);
	await finishLane(findByBatchId(directory, 'r09-reviewer', SESSION_ID)[0]!);
	await write('post_reviewer', 'DISPROVED', 'suppress_with_reason');
	await write('post_critic', 'DISPROVED', 'suppress_with_reason');
	const completion = (await run('complete_pr_workflow', {
		mode: 'PR_REVIEW',
		pr_head_sha: HEAD_SHA,
		report_verdict: 'APPROVE',
	})) as CompletionReport;
	expect(completion).toMatchObject({
		success: true,
		status: 'completed',
		gate_cleared: true,
		terminal_report: {
			kind: 'COMPLETE',
			unresolved_dimensions: [],
			live_dimensions: [],
		},
	});
	expect(new Set(completion.terminal_report.covered_dimensions)).toEqual(
		new Set(PR_REVIEW_BASE_DIMENSION_IDS),
	);
	return completion;
}
/** Staged tier-M attempt 0: singleton canary, then the 5-obligation fanout. */
async function settleStagedBase(canaryId: string, fanoutId: string) {
	await dispatch(canaryId, 'swarm-pr-review:base', [CANARY_DIM], {
		wave: { stage: 'canary', attempt: 0 },
	});
	await submitAndFinish(canaryId);
	await dispatch(fanoutId, 'swarm-pr-review:base', FANOUT, {
		wave: { stage: 'fanout', attempt: 0 },
	});
	await submitAndFinish(fanoutId);
}
beforeEach(async () => {
	directory = canonicalMkdtemp('pr-review-r09-off-on-');
	await initializeGitRepository(directory);
	nextChild = 0;
	deliveredPrompts = new Map();
	resilienceEnabled = false;
	gateInternals.resetTrackedStateCache();
	Object.assign(gateInternals, {
		resolveCurrentGitHead: () => HEAD_SHA,
		resolveCurrentGitHeadAsync: async () => HEAD_SHA,
		resolvePrWorkflowRevisionDigest: () => REVISION_DIGEST,
		resolvePrWorkflowRevisionDigestDetailed: () => ({
			ok: true,
			digest: REVISION_DIGEST,
		}),
		resolveIsWorkingTreeClean: () => true,
		resolveIsWorkingTreeCleanAsync: async () => true,
		resolvePrReviewDiffStats: () => ({
			changedLines: 400,
			changedFiles: 12,
			hasSubmoduleChange: false,
		}),
		resolvePrReviewDiffStatsAsync: (...args) =>
			gateInternals.resolvePrReviewDiffStats(...args),
	});
	Object.assign(dispatchInternals, {
		resolvePrWorkflowRevisionDigestAsync: async () => REVISION_DIGEST,
		resolveExactMergeBaseAsync: async () => BASE_SHA,
		getGeneratedAgentNames: () => ['explorer', 'reviewer'],
		loadPluginConfig: () => ({
			pr_review_resilience: {
				...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
				enabled: resilienceEnabled,
			},
		}),
	});
	Object.assign(triggerInternals, {
		resolvePrWorkflowRevisionDigest: () => REVISION_DIGEST,
		resolvePrWorkflowRevisionDigestAsync: async () => REVISION_DIGEST,
		resolveMergeBase: () => BASE_SHA,
		resolveMergeBaseAsync: async () => BASE_SHA,
	});
	plugin = await bootKnowledgeHost(
		directory,
		{},
		createIssue2469HostClient({
			nextChildId: () => `r09-child-${++nextChild}`,
			onPrompt: (sessionID, prompt) => deliveredPrompts.set(sessionID, prompt),
		}),
	);
});
afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	Object.assign(gateInternals, originalGate);
	Object.assign(dispatchInternals, originalDispatch);
	Object.assign(triggerInternals, originalTrigger);
	closeAllProjectDbs();
	safeRmRecursive(directory);
});

describe('r09 resilience off/on (issue 2586, AC2/R09)', () => {
	test('OFF leg: legacy one-wave base dispatch completes CLEAN end to end', async () => {
		resilienceEnabled = false;
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		await dispatch('r09-off-base', 'swarm-pr-review:base', CONSOLIDATED);
		await submitAndFinish('r09-off-base');
		// One legacy base batch, no staged attempts (completing clears state).
		const state = await readPrWorkflowGateState(directory, SESSION_ID);
		expect(state?.prReviewBaseDispatches).toHaveLength(1);
		expect(state?.prReviewResilience?.attempts ?? []).toHaveLength(0);
		const completion = await finishJourney();
		expect(completion.terminal_report.allowed_verdicts).toContain('APPROVE');
	}, 60_000);

	test('ON leg: staged canary/fanout completes CLEAN; one-wave refused; identity survives restart', async () => {
		resilienceEnabled = true;
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		// Pinned contrast: enabled at tier M, one-wave is refused pre-launch.
		await dispatch('r09-on-refused', 'swarm-pr-review:base', CONSOLIDATED, {
			expectStagedRefusal: true,
		});
		expect(deliveredPrompts.size).toBe(0);
		await settleStagedBase('r09-on-canary', 'r09-on-fanout');
		const state = await readPrWorkflowGateState(directory, SESSION_ID);
		expect(state?.prReviewBaseDispatches).toHaveLength(2);
		// Restart simulation (r13): drop in-memory state, re-read durable state.
		const records = () => [
			...findByBatchId(directory, 'r09-on-canary', SESSION_ID),
			...findByBatchId(directory, 'r09-on-fanout', SESSION_ID),
		];
		gateInternals.resetTrackedStateCache();
		const restarted = await readPrWorkflowGateState(directory, SESSION_ID);
		expect(restarted?.workflowInstanceId).toBe(state?.workflowInstanceId);
		expect(restarted?.revision).toBe(state?.revision);
		expect(restarted?.prHeadSha).toBe(HEAD_SHA);
		for (const record of records()) {
			expect(record.status).toBe('completed');
			const receipt = record.result?.prReviewResultReceipt;
			expect(receipt?.workflowRevision).toBe(record.workflowGeneration);
			expect(receipt?.workflowInstanceId).toBe(restarted?.workflowInstanceId);
		}
		// The staged admission identity (attempt 0 canary + fanout) is durable.
		expect(restarted?.prReviewResilience?.attempts.at(-1)).toMatchObject({
			attempt: 0,
			canaryBatchId: 'r09-on-canary',
			canaryWorkflowLane: CANARY_DIM,
			fanoutBatchId: 'r09-on-fanout',
		});
		await finishJourney();
	}, 60_000);

	test('retry leg: only the terminally failed lane is re-dispatched; successful producers are never relaunched', async () => {
		resilienceEnabled = false;
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		// Six singleton base lanes (a valid tier-M initial wave).
		await dispatch(
			'r09-retry-base',
			'swarm-pr-review:base',
			PR_REVIEW_BASE_DIMENSION_IDS,
		);
		const base = () => findByBatchId(directory, 'r09-retry-base', SESSION_ID);
		expect(base()).toHaveLength(6);
		const deadDimension = PR_REVIEW_BASE_DIMENSION_IDS[4]!;
		const failed = base().find((r) => r.workflowLane === deadDimension)!;
		// Skip by durable key: submitAndFinish re-reads the store, so a
		// pre-read record object is never identical to a re-read one.
		await submitAndFinish(
			'r09-retry-base',
			(record) => record.laneId === failed.laneId,
		);
		await failLane(failed);
		const successfulBefore = base()
			.filter((r) => r.laneId !== failed.laneId)
			.map((r) => JSON.stringify(r));
		const promptsBefore = new Set(deliveredPrompts.keys());
		// Partial retry: a NEW batch id carrying ONLY the failed lane — a
		// same-batch-id retry is impossible (base batch ids are append-only).
		await dispatch('r09-retry-relaunch', 'swarm-pr-review:base', [
			deadDimension,
		]);
		// No new child prompt except the retry child (a NEW session).
		const newPrompts = [...deliveredPrompts.keys()].filter(
			(id) => !promptsBefore.has(id),
		);
		const retry = findByBatchId(directory, 'r09-retry-relaunch', SESSION_ID);
		expect(retry).toHaveLength(1);
		expect(newPrompts).toEqual([retry[0]!.subagentSessionId]);
		const successfulAfter = base()
			.filter((r) => r.workflowLane !== deadDimension)
			.map((r) => JSON.stringify(r));
		expect(successfulAfter).toEqual(successfulBefore);
		await submitAndFinish('r09-retry-relaunch');
		await finishJourney();
	}, 60_000);
});
