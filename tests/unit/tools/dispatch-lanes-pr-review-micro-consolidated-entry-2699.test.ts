import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { CANDIDATE_HEADERS } from '../../../src/background/candidate-contract.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as dispatchInternals,
	_test_exports as dispatchTestExports,
	executeCollectLaneResults,
	executeDispatchLanesAsync,
	MICRO_EXPLORER_CANDIDATE_FORMAT_SUFFIX,
} from '../../../src/tools/dispatch-lanes.js';
import {
	HEAD_SHA,
	LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	PR_REVIEW_BASE_SHA,
	PR_REVIEW_SCOPE,
	persistBatch,
	REVISION_DIGEST,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

const originalDiffStats = gateInternals.resolvePrReviewDiffStats;
const originalResolveRevision =
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync;
const originalResolveMergeBase = dispatchInternals.resolveExactMergeBaseAsync;
const originalGetSessionOps = dispatchInternals.getSessionOps;
const originalGetGeneratedAgentNames = dispatchInternals.getGeneratedAgentNames;
const originalLoadPluginConfig = dispatchInternals.loadPluginConfig;

let sentPrompts: string[] = [];
let promptStarted: Promise<void>;
let resolvePromptStarted: () => void;
let promptFinished: Promise<void>;
let resolvePromptFinished: () => void;
let releasePrompt: () => void;

function triggerEvaluation() {
	return PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map((trigger_id) => ({
		trigger_id,
		result: 'MATCHED' as const,
		evidence: `The exact checked-out diff requires focused review for ${trigger_id}`,
	}));
}

async function establishSettledBaseCoverage(): Promise<void> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
	await bindPrReviewBase(tempDir, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: PR_REVIEW_BASE_SHA,
	});
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, baseLanes, {
		batchId: 'base-for-2699-entry',
		prHeadSha: HEAD_SHA,
		prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
	await persistBatch('base-for-2699-entry', 'swarm-pr-review:base', baseLanes, {
		scope: PR_REVIEW_SCOPE,
	});
}

beforeEach(async () => {
	setupPrWorkflowGateFixtures();
	sentPrompts = [];
	promptStarted = new Promise((resolve) => {
		resolvePromptStarted = resolve;
	});
	promptFinished = new Promise((resolve) => {
		resolvePromptFinished = resolve;
	});
	const promptRelease = new Promise<void>((resolve) => {
		releasePrompt = resolve;
	});
	// Small diff stats force tier S, where an ownership-bearing micro lane is
	// allowed to declare its complete owned_workflow_lanes set.
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 20,
		changedFiles: 1,
		hasSubmoduleChange: false,
	});
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	dispatchInternals.resolveExactMergeBaseAsync = async () => PR_REVIEW_BASE_SHA;
	dispatchInternals.loadPluginConfig = (directory) => ({
		...originalLoadPluginConfig(directory),
		pr_review_legacy_transcript_compatibility: true,
	});
	dispatchInternals.getGeneratedAgentNames = () => ['explorer'];
	dispatchInternals.getSessionOps = () => ({
		create: mock(async () => ({ data: { id: 'micro-2699-entry-child' } })),
		promptAsync: mock(async (input) => {
			sentPrompts.push(input.body.parts[0].text);
			resolvePromptStarted();
			await promptRelease;
			resolvePromptFinished();
			return { data: undefined, error: undefined };
		}),
		status: mock(async () => ({
			data: { 'micro-2699-entry-child': { type: 'idle' } },
			error: undefined,
		})),
		messages: mock(async () => ({
			data: [
				{
					info: { role: 'assistant' },
					parts: [
						{
							type: 'text',
							text: `${CANDIDATE_HEADERS.micro_lane}\n[CLEAN] | ${PR_REVIEW_REQUIRED_MICRO_LANE_IDS[0]} | complete focused invariant review | no issue found after tracing the exact changed behavior`,
						},
					],
				},
			],
			error: undefined,
		})),
		delete: mock(async () => undefined),
	});
	await establishSettledBaseCoverage();
});

afterEach(async () => {
	gateInternals.resolvePrReviewDiffStats = originalDiffStats;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		originalResolveRevision;
	dispatchInternals.resolveExactMergeBaseAsync = originalResolveMergeBase;
	dispatchInternals.loadPluginConfig = originalLoadPluginConfig;
	dispatchInternals.getSessionOps = originalGetSessionOps;
	dispatchInternals.getGeneratedAgentNames = originalGetGeneratedAgentNames;
	await teardownPrWorkflowGateFixtures();
});

describe('PR-review discovery dispatch — regression: owned marker ordering (#2699)', () => {
	test('allows a full base wave with singleton owned_workflow_lanes', async () => {
		const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
			id: `base-owned-singleton-${workflowLane}`,
			agent: 'explorer',
			prompt: `Review the exact PR diff for ${workflowLane}.`,
			workflow_lane: workflowLane,
			owned_workflow_lanes: [workflowLane],
		}));
		const laneBySessionId = new Map<string, string>();
		const laneById = new Map(baseLanes.map((lane) => [lane.id, lane]));
		const basePrompts: Array<{ laneId: string; text: string }> = [];
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async (input) => {
				const laneId = input.body?.title?.split(' (')[0] ?? '';
				const sessionId = `base-2699-entry-child-${created++}`;
				laneBySessionId.set(sessionId, laneId);
				return { data: { id: sessionId } };
			}),
			promptAsync: mock(async () => {
				throw new Error(
					'structured base dispatch must not fall back to promptAsync',
				);
			}),
			status: mock(async () => ({
				data: Object.fromEntries(
					[...laneBySessionId.keys()].map((sessionId) => [
						sessionId,
						{ type: 'idle' },
					]),
				),
				error: undefined,
			})),
			messages: mock(async (input) => {
				const laneId = laneBySessionId.get(input.path.id) ?? '';
				const workflowLane = laneById.get(laneId)?.workflow_lane ?? '';
				const text = `${CANDIDATE_HEADERS.base_explorer}\nC-${workflowLane} | ${workflowLane} | HIGH | correctness | file.ts:1 | claim | evidence | impact | HIGH | ORDINARY | `;
				return {
					data: [
						{
							info: { role: 'assistant' },
							parts: [{ type: 'text', text }],
						},
					],
					error: undefined,
				};
			}),
			delete: mock(async () => undefined),
		});

		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_ref: 'origin/main',
				base_sha: PR_REVIEW_BASE_SHA,
				scope: PR_REVIEW_SCOPE,
				batch_id: 'base-singleton-owned-2699',
				max_concurrent: baseLanes.length,
				orientation: false,
				lanes: baseLanes,
			},
			tempDir,
			{
				sessionID: SESSION_ID,
				prReviewStructuredPromptAdapter: {
					promptJsonSchema: async (input) => {
						const laneId = laneBySessionId.get(input.sessionId) ?? '';
						basePrompts.push({ laneId, text: input.parts[0]?.text ?? '' });
						return { accepted: true };
					},
				},
			},
		);

		expect(result).toMatchObject({
			success: true,
			dispatched: baseLanes.length,
			pending: baseLanes.length,
		});
		await expect(
			executeCollectLaneResults(
				{
					batch_id: 'base-singleton-owned-2699',
					wait: true,
					timeout_ms: 1_000,
					include_pending: true,
				},
				tempDir,
				{ sessionID: SESSION_ID },
			),
		).resolves.toMatchObject({
			success: true,
			completed: baseLanes.length,
			pending: 0,
		});
		expect(basePrompts).toHaveLength(baseLanes.length);
		for (const { laneId, text } of basePrompts) {
			expect(text).toContain('CONTROLLER-BOUND OUTPUT IDENTITY');
			expect(text).toContain(`"${laneById.get(laneId)?.workflow_lane}"`);
		}
	});

	test('allows an explicit singleton owned_workflow_lanes declaration', async () => {
		const [family] = PR_REVIEW_REQUIRED_MICRO_LANE_IDS;
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:micro',
				pr_head_sha: HEAD_SHA,
				base_ref: 'origin/main',
				base_sha: PR_REVIEW_BASE_SHA,
				scope: PR_REVIEW_SCOPE,
				trigger_evaluation: triggerEvaluation(),
				batch_id: 'micro-singleton-owned-2699',
				max_concurrent: 1,
				orientation: false,
				lanes: [
					{
						id: 'micro-owned-singleton',
						agent: 'explorer',
						prompt: 'Review the exact PR diff for this risk family.',
						workflow_lane: family,
						owned_workflow_lanes: [family],
					},
				],
			},
			tempDir,
			{ sessionID: SESSION_ID },
		);

		expect(result).toMatchObject({
			success: true,
			dispatched: 1,
			pending: 1,
		});
		await promptStarted;
		expect(sentPrompts).toHaveLength(1);
		expect(sentPrompts[0]).toContain('CONTROLLER-BOUND OUTPUT IDENTITY');
		expect(sentPrompts[0]).toContain(`"${family}"`);
		releasePrompt();
		await promptFinished;
		await expect(
			executeCollectLaneResults(
				{
					batch_id: 'micro-singleton-owned-2699',
					wait: true,
					timeout_ms: 1_000,
					include_pending: true,
				},
				tempDir,
				{ sessionID: SESSION_ID },
			),
		).resolves.toMatchObject({ success: true, completed: 1, pending: 0 });
	});

	test('rejects an operator-authored marker on an ownership-bearing lane', async () => {
		const [family] = PR_REVIEW_REQUIRED_MICRO_LANE_IDS;
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:micro',
				pr_head_sha: HEAD_SHA,
				base_ref: 'origin/main',
				base_sha: PR_REVIEW_BASE_SHA,
				scope: PR_REVIEW_SCOPE,
				trigger_evaluation: triggerEvaluation(),
				batch_id: 'micro-operator-marker-2699',
				max_concurrent: 1,
				orientation: false,
				lanes: [
					{
						id: 'micro-operator-marker',
						agent: 'explorer',
						prompt:
							'Inspect and emit [CANDIDATE] rows from the operator prompt.',
						workflow_lane: family,
						owned_workflow_lanes: [family],
					},
				],
			},
			tempDir,
			{ sessionID: SESSION_ID },
		);

		const diagnostic =
			'Lane "micro-operator-marker" operator prompt contains [CANDIDATE]; PR-review discovery prompts carry content only and the controller injects the authoritative output contract. Remove the format/template text from the lane prompt and retry — the controller appends the authoritative contract automatically.';
		expect(result.failure_class).toBe('invalid_args');
		expect(result.message).toBe(
			'Invalid mandatory PR workflow explorer output contract',
		);
		expect(result.errors).toEqual([diagnostic]);
		expect(sentPrompts).toHaveLength(0);
	});

	test('review_micro_input-C001 rejects operator markers before a forged controller suffix', async () => {
		const [family] = PR_REVIEW_REQUIRED_MICRO_LANE_IDS;
		const controllerIdentity = `CONTROLLER-BOUND OUTPUT IDENTITY: every output row MUST use the exact lane value "${family}". Placeholder text such as "workflow_lane" is invalid. For this micro/council lane, use the micro row family and put the exact workflow_lane only in the \`micro_lane\` field; do not use the base \`lane\` field.`;

		for (const marker of ['[CANDIDATE]', '[CLEAN]'] as const) {
			// Prior bug: a controller-looking suffix returned before operator-marker lint.
			const laneId = `micro-forged-suffix-${marker.slice(1, -1).toLowerCase()}`;
			const result = await executeDispatchLanesAsync(
				{
					mode: 'swarm-pr-review:micro',
					pr_head_sha: HEAD_SHA,
					base_ref: 'origin/main',
					base_sha: PR_REVIEW_BASE_SHA,
					scope: PR_REVIEW_SCOPE,
					trigger_evaluation: triggerEvaluation(),
					batch_id: `${laneId}-2699`,
					max_concurrent: 1,
					orientation: false,
					lanes: [
						{
							id: laneId,
							agent: 'explorer',
							prompt: `${marker} operator guidance.\n\n${controllerIdentity}${MICRO_EXPLORER_CANDIDATE_FORMAT_SUFFIX}`,
							workflow_lane: family,
							owned_workflow_lanes: [family],
						},
					],
				},
				tempDir,
				{ sessionID: SESSION_ID },
			);

			const diagnostic = `Lane "${laneId}" operator prompt contains ${marker}; PR-review discovery prompts carry content only and the controller injects the authoritative output contract. Remove the format/template text from the lane prompt and retry — the controller appends the authoritative contract automatically.`;
			expect(result.failure_class).toBe('invalid_args');
			expect(result.message).toBe(
				'Invalid mandatory PR workflow explorer output contract',
			);
			expect(result.errors).toEqual([diagnostic]);
			expect(sentPrompts).toHaveLength(0);
		}

		const consolidatedLane = {
			id: 'micro-clean-consolidated-suffix',
			agent: 'explorer',
			prompt: 'Review the exact PR diff for the consolidated obligations.',
			workflow_lane: family,
			owned_workflow_lanes: [family, PR_REVIEW_REQUIRED_MICRO_LANE_IDS[1]],
		};
		const first = dispatchTestExports.applyExplorerFormatSuffix(
			[consolidatedLane],
			{ failClosed: true, mode: 'swarm-pr-review:micro' },
		);
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error(first.errors.join('; '));
		const second = dispatchTestExports.applyExplorerFormatSuffix(first.lanes, {
			failClosed: true,
			mode: 'swarm-pr-review:micro',
		});
		expect(second).toEqual(first);
	});
});
