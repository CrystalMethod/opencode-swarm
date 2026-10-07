/**
 * Issue #2865 regression: the collect-vs-receipt-publish race.
 *
 * The collect-time discovery validation decided from the pass-entry record
 * snapshot, so a structured receipt published to the durable record mid-pass
 * (after the snapshot, before the lane's sequential settle) was invisible to
 * the decision: the lane terminally failed with
 * PR_REVIEW_DISCOVERY_CONTRACT_INVALID ... "missing structured receipt" while
 * the same durable record carried the valid exactly-bound receipt.
 *
 * The fix re-reads the lane's durable record once when a PR-review discovery
 * validation fails without a receipt in the prospective result, and settles on
 * a receipt that has appeared. Legs:
 *  - A (the race): mid-pass publish (played inside the session.messages mock,
 *    i.e. after the pass-start snapshot load, before settle) must settle the
 *    lane `completed` on the receipt.
 *  - B (control): receipt published BEFORE the collect invocation settles
 *    `completed` (also the pre-fix behavior; proves the probe is not vacuous).
 *  - C (control): a lane with no receipt anywhere still settles `error` with
 *    the missing-receipt contract failure (genuine failures are preserved).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	findByBatchId,
	publishPrReviewResultReceipt,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	encodePrReviewWorkflowBinding,
	prReviewLaneResultEnvelopeDigest,
} from '../../../src/background/pr-review-contract.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	_test_exports,
	executeCollectLaneResults,
} from '../../../src/tools/dispatch-lanes.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const BASE_SHA = '5f9144349970d5af3e2d46773599a1208a60ec01';
const HEAD_SHA = 'aa112233445566778899aabbccddeeff00112233';
const REVISION_DIGEST = 'd'.repeat(64);
const CHILD_TEXT = 'Settled.\n\nReceipt id: 9f1af6ed4c64';
const CREDITED_LANE = 'tests-falsifiability';
const UNRESOLVED_LANE = 'security-trust';
const PARENT = 'race-parent-2865';

const originalInternals = { ..._internals };
const originalGateInternals = { ...gateInternals };
let directory = '';

beforeEach(async () => {
	directory = canonicalMkdtemp('collect-receipt-race-2865-');
	fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.resolvePrReviewDiffStatsAsync = async () => ({
		changedLines: 2,
		changedFiles: 1,
		hasSubmoduleChange: false,
	});
	_internals.resolvePrWorkflowRevisionDigestAsync = async () => REVISION_DIGEST;
	await activatePrWorkflow(directory, PARENT, 'PR_REVIEW', {
		prHeadSha: HEAD_SHA,
	});
	await bindPrReviewBase(directory, PARENT, {
		prHeadSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: BASE_SHA,
	});
});

afterEach(async () => {
	Object.assign(_internals, originalInternals);
	Object.assign(gateInternals, originalGateInternals);
	gateInternals.resetTrackedStateCache();
	_test_exports.resetDeliveredLaneOutputs();
	closeAllProjectDbs();
	for (let i = 0; ; i++) {
		try {
			fs.rmSync(directory, { recursive: true, force: true });
			break;
		} catch (error) {
			if (i >= 4 || (error as NodeJS.ErrnoException).code !== 'EBUSY') {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
});

async function workflowIdentity(): Promise<{
	instance: string;
	revision: number;
}> {
	const state = await readPrWorkflowGateState(directory, PARENT);
	expect(state).not.toBeNull();
	expect(state?.workflowInstanceId).toBeDefined();
	expect(state?.revision).toBeDefined();
	return { instance: state!.workflowInstanceId!, revision: state!.revision! };
}

function buildReceipt(args: {
	instance: string;
	revision: number;
	batchId: string;
	laneId: string;
	child: string;
}) {
	const envelope = {
		schemaVersion: 1 as const,
		outcome: 'INCOMPLETE' as const,
		creditedLanes: [CREDITED_LANE],
		findings: [
			{
				id: 'R-1',
				workflowLane: CREDITED_LANE,
				severity: 'HIGH' as const,
				riskImpact: 'ORDINARY' as const,
				riskTags: [],
				title: 'Race regression finding',
				body: 'Receipt-backed settlement probe.',
				evidence: 'Deterministic mid-pass receipt publish.',
				location: {
					kind: 'non_local' as const,
					label: 'receipt',
					detail: 'lane-settlement',
				},
			},
		],
		cleanAttestations: [],
		unresolved: [
			{
				workflowLane: UNRESOLVED_LANE,
				reason: 'RESOURCE_LIMIT' as const,
				detail: 'fixture-unresolved-lane',
			},
		],
	};
	return {
		schemaVersion: 1,
		mode: 'swarm-pr-review:base',
		workflowInstanceId: args.instance,
		workflowRevision: args.revision,
		batchId: args.batchId,
		laneId: args.laneId,
		workflowLane: CREDITED_LANE,
		ownedWorkflowLanes: [CREDITED_LANE, UNRESOLVED_LANE],
		baseSha: BASE_SHA,
		headSha: HEAD_SHA,
		dispatchRevisionDigest: REVISION_DIGEST,
		childSessionId: args.child,
		generation: 1,
		semanticEnvelopeDigest: prReviewLaneResultEnvelopeDigest(envelope),
		envelope,
	};
}

async function seedLane(args: {
	instance: string;
	revision: number;
	batchId: string;
	laneId: string;
	child: string;
}): Promise<void> {
	const recorded = await recordPendingDelegation(directory, {
		correlationId: args.child,
		jobId: encodePrReviewWorkflowBinding(args.instance),
		subagentSessionId: args.child,
		parentSessionId: PARENT,
		callID: `call-${args.child}`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: args.batchId,
		laneId: args.laneId,
		mode: 'swarm-pr-review:base',
		workflowLane: CREDITED_LANE,
		ownedWorkflowLanes: [CREDITED_LANE, UNRESOLVED_LANE],
		// Legacy transcript adapter intentionally not set: default-off is the
		// live-run shape that leaves no fallback when the receipt is missed.
		promptHash: 'prompt-hash-2865',
		workflowGeneration: args.revision,
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: `complete PR diff ${BASE_SHA}...${HEAD_SHA}`,
		},
		generation: 1,
	});
	expect(recorded).not.toBeNull();
}

function installSessionOps(args: {
	child: string;
	onMessages?: () => Promise<unknown>;
}): void {
	_test_exports.resetDeliveredLaneOutputs();
	_internals.getSessionOps = () => ({
		create: async () => ({ data: { id: 'unused' }, error: undefined }),
		prompt: async () => ({ data: null, error: undefined }),
		promptAsync: async () => ({ data: undefined, error: undefined }),
		status: async () => ({
			data: { [args.child]: { type: 'idle' } },
			error: undefined,
		}),
		messages: async () => {
			if (args.onMessages) await args.onMessages();
			return {
				data: [
					{
						info: { role: 'assistant' },
						parts: [{ type: 'text', text: CHILD_TEXT }],
					},
				],
				error: undefined,
			};
		},
	});
}

function readLane(batchId: string, child: string) {
	return findByBatchId(directory, batchId).find(
		(record) => record.subagentSessionId === child,
	);
}

async function publishReceipt(args: {
	instance: string;
	revision: number;
	batchId: string;
	laneId: string;
	child: string;
}) {
	return publishPrReviewResultReceipt(directory, {
		parentSessionId: PARENT,
		childSessionId: args.child,
		batchId: args.batchId,
		laneId: args.laneId,
		expectedWorkflowInstanceId: args.instance,
		expectedWorkflowRevision: args.revision,
		expectedBaseSha: BASE_SHA,
		receipt: buildReceipt(args),
	});
}

async function runLeg(mode: 'race' | 'pre' | 'none') {
	const batchId = `race-${mode}-batch`;
	const laneId = `race-${mode}-lane`;
	const child = `race-${mode}-child`;
	const { instance, revision } = await workflowIdentity();
	await seedLane({ instance, revision, batchId, laneId, child });
	if (mode === 'pre') {
		const published = await publishReceipt({
			instance,
			revision,
			batchId,
			laneId,
			child,
		});
		expect(published.status).toBe('recorded');
	}
	let racedPublishStatus: string | undefined;
	installSessionOps({
		child,
		...(mode === 'race'
			? {
					onMessages: async () => {
						// Mid-pass: the pass-start snapshot is already loaded
						// (executeCollectLaneResults entry read); this publish
						// lands before the lane's sequential settle.
						const published = await publishReceipt({
							instance,
							revision,
							batchId,
							laneId,
							child,
						});
						racedPublishStatus = published.status;
					},
				}
			: {}),
	});
	await executeCollectLaneResults(
		{ batch_id: batchId, wait: false },
		directory,
		{ sessionID: PARENT },
	);
	const lane = readLane(batchId, child);
	expect(lane).toBeDefined();
	return { lane: lane!, racedPublishStatus };
}

describe('collect-vs-receipt-publish race (#2865)', () => {
	test('a receipt published mid-pass settles the lane completed on the receipt', async () => {
		const { lane, racedPublishStatus } = await runLeg('race');
		expect(racedPublishStatus).toBe('recorded');
		expect(lane.status).toBe('completed');
		expect(lane.result?.prReviewResultReceipt).toBeDefined();
		expect(lane.result?.error).toBeUndefined();
		expect(lane.result?.workflowLaneFailureClass).toBeUndefined();
	});

	test('a pre-published receipt still settles completed (control)', async () => {
		const { lane } = await runLeg('pre');
		expect(lane.status).toBe('completed');
		expect(lane.result?.prReviewResultReceipt).toBeDefined();
	});

	test('a genuinely receipt-less lane still fails the discovery contract (control)', async () => {
		const { lane } = await runLeg('none');
		expect(lane.status).toBe('error');
		expect(lane.result?.workflowLaneFailureClass).toBe('contract');
		expect(lane.result?.error).toContain('missing structured receipt');
		expect(lane.result?.prReviewResultReceipt).toBeUndefined();
	});
});
