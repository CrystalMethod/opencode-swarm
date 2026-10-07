/**
 * Issue #2865 regression: claim-first interleaving — a publish after a won
 * claim settles the lane.
 *
 * When the terminal claim wins the store lock before the child's receipt
 * publish lands, the record terminalizes error-without-receipt and the
 * genuine exactly-bound publish would be rejected as `terminal` (receipt
 * lost). `publishPrReviewResultReceipt` admits such a publish onto the
 * provably-stale error/`contract` terminal — one that PASSED record-result
 * integrity and failed only at the receipt branch — settling the record
 * `completed` on the receipt with the stale error/class dropped from BOTH
 * result levels. Degraded/empty content-integrity terminals keep their typed
 * failure and are never admitted; a non-binding receipt conflicts;
 * `liveness` terminals keep the #2585/#2700 parent-repair lever.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildBackgroundCompletionEventId,
	claimTerminalResult,
	findByCorrelationId,
	publishPrReviewResultReceipt,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	encodePrReviewWorkflowBinding,
	prReviewLaneResultEnvelopeDigest,
} from '../../../src/background/pr-review-contract.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const BASE_SHA = '5f9144349970d5af3e2d46773599a1208a60ec01';
const HEAD_SHA = 'aa112233445566778899aabbccddeeff00112233';
const REVISION_DIGEST = 'd'.repeat(64);
const WORKFLOW_INSTANCE = '12a87cf3-edad-4057-ba96-8afada460c4d';
const WORKFLOW_REVISION = 5;
const CREDITED_LANE = 'tests-falsifiability';
const UNRESOLVED_LANE = 'security-trust';
const PARENT = 'claim-first-parent-2865';
const NOW = 2_000_000_000_000;

let directory = '';
let legIndex = 0;

beforeEach(() => {
	legIndex += 1;
	directory = canonicalMkdtemp(`claim-first-2865-${legIndex}-`);
	fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
});

afterEach(async () => {
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

interface Leg {
	batchId: string;
	laneId: string;
	child: string;
	receipt: ReturnType<typeof buildReceipt>;
}

function buildReceipt(args: {
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
				title: 'Claim-first regression finding',
				body: 'Receipt published after the stale terminal claim.',
				evidence: 'Store-level admission probe.',
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
		workflowInstanceId: WORKFLOW_INSTANCE,
		workflowRevision: WORKFLOW_REVISION,
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

async function seedOpenLane(publish: boolean): Promise<Leg> {
	const suffix = `l${legIndex}`;
	const leg: Leg = {
		batchId: `claim-first-batch-${suffix}`,
		laneId: `claim-first-lane-${suffix}`,
		child: `claim-first-child-${suffix}`,
		receipt: undefined as never,
	};
	leg.receipt = buildReceipt(leg);
	const recorded = await recordPendingDelegation(directory, {
		correlationId: leg.child,
		jobId: encodePrReviewWorkflowBinding(WORKFLOW_INSTANCE),
		subagentSessionId: leg.child,
		parentSessionId: PARENT,
		callID: `call-${leg.child}`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: leg.batchId,
		laneId: leg.laneId,
		mode: 'swarm-pr-review:base',
		workflowLane: CREDITED_LANE,
		ownedWorkflowLanes: [CREDITED_LANE, UNRESOLVED_LANE],
		promptHash: 'prompt-hash-2865-cf',
		workflowGeneration: WORKFLOW_REVISION,
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
	if (!publish) return leg;
	const published = await publishPrReviewResultReceipt(directory, {
		parentSessionId: PARENT,
		childSessionId: leg.child,
		batchId: leg.batchId,
		laneId: leg.laneId,
		expectedWorkflowInstanceId: WORKFLOW_INSTANCE,
		expectedWorkflowRevision: WORKFLOW_REVISION,
		expectedBaseSha: BASE_SHA,
		receipt: leg.receipt,
	});
	expect(published.status).toBe('recorded');
	return leg;
}

function staleTerminal(args: {
	child: string;
	error: string;
	failureClass: 'contract' | 'liveness';
	receipt?: unknown;
	outputDegraded?: boolean;
}) {
	const resultDigest = createHash('sha256').update(args.error).digest('hex');
	return {
		eventId: buildEventId(args.child, resultDigest),
		status: 'error' as const,
		recordedAt: NOW,
		result: {
			error: args.error,
			chars: args.error.length,
			truncated: false,
			digest: resultDigest,
			workflowLaneFailureClass: args.failureClass,
			...(args.outputDegraded ? { outputDegraded: true } : {}),
			...(args.receipt ? { prReviewResultReceipt: args.receipt } : {}),
		},
	};
}

function buildEventId(child: string, resultDigest: string): string {
	return buildBackgroundCompletionEventId({
		correlationId: child,
		jobId: encodePrReviewWorkflowBinding(WORKFLOW_INSTANCE),
		status: 'error' as const,
		resultDigest,
	});
}

const MISSING_RECEIPT_ERROR =
	'PR_REVIEW_DISCOVERY_CONTRACT_INVALID: predicate=discovery.coverage ' +
	'actual="missing structured receipt (legacy transcript adapter disabled)"';

async function claimStaleTerminalFirst(
	leg: Leg,
	errorText?: string,
	outputDegraded?: boolean,
) {
	const claimed = await claimTerminalResult(
		directory,
		leg.child,
		staleTerminal({
			child: leg.child,
			error: errorText ?? MISSING_RECEIPT_ERROR,
			failureClass: 'contract',
			outputDegraded,
		}),
	);
	expect(claimed?.disposition).toBe('claimed');
	const lane = findByCorrelationId(directory, leg.child);
	expect(lane?.status).toBe('error');
	expect(lane?.result?.prReviewResultReceipt).toBeUndefined();
	return lane!;
}

async function publishLegReceipt(leg: Leg, receiptOverride?: unknown) {
	return publishPrReviewResultReceipt(directory, {
		parentSessionId: PARENT,
		childSessionId: leg.child,
		batchId: leg.batchId,
		laneId: leg.laneId,
		expectedWorkflowInstanceId: WORKFLOW_INSTANCE,
		expectedWorkflowRevision: WORKFLOW_REVISION,
		expectedBaseSha: BASE_SHA,
		receipt: (receiptOverride ?? leg.receipt) as never,
	});
}

describe('claim-first interleaving: a publish after a won claim settles the lane (#2865)', () => {
	test('an exactly-bound receipt admitted after the won claim settles the record completed', async () => {
		const leg = await seedOpenLane(false);
		await claimStaleTerminalFirst(leg);
		const published = await publishLegReceipt(leg);
		expect(published.status).toBe('recorded');
		const lane = findByCorrelationId(directory, leg.child);
		expect(lane?.status).toBe('completed');
		expect(lane?.terminalResult?.status).toBe('completed');
		expect(lane?.terminalResult?.result.prReviewResultReceipt).toBeDefined();
		expect(lane?.terminalResult?.result.error).toBeUndefined();
		expect(
			lane?.terminalResult?.result.workflowLaneFailureClass,
		).toBeUndefined();
		// The folded record's own result must be sanitized too: downstream
		// consumers project record.result.* (the collect lane projection), so
		// a stale contract error next to the receipt would re-introduce the
		// self-contradicting state one level down (final-critic round 2).
		expect(lane?.result?.error).toBeUndefined();
		expect(lane?.result?.workflowLaneFailureClass).toBeUndefined();
		expect(lane?.result?.prReviewResultReceipt).toBeDefined();
		// Identity-on-acceptance: the persisted receipt must be exactly the
		// published one, not just any receipt-shaped object.
		const persisted = lane?.result?.prReviewResultReceipt as Record<
			string,
			unknown
		>;
		expect(persisted?.semanticEnvelopeDigest).toBe(
			leg.receipt.semanticEnvelopeDigest,
		);
		expect(persisted?.batchId).toBe(leg.receipt.batchId);
		expect(persisted?.laneId).toBe(leg.receipt.laneId);
		expect(persisted?.childSessionId).toBe(leg.receipt.childSessionId);
		// Idempotent: a replay of the same publish is a duplicate, not a flip.
		const replay = await publishLegReceipt(leg);
		expect(replay.status).toBe('duplicate');
		const after = findByCorrelationId(directory, leg.child);
		expect(after?.status).toBe('completed');
		expect(after?.result?.error).toBeUndefined();
	});

	test('a degraded-output stale terminal is NOT admitted; the typed contract failure is preserved', async () => {
		const leg = await seedOpenLane(false);
		await claimStaleTerminalFirst(
			leg,
			'discovery validation failed on degraded output',
			true,
		);
		const published = await publishLegReceipt(leg);
		expect(published.status).toBe('terminal');
		const lane = findByCorrelationId(directory, leg.child);
		expect(lane?.status).toBe('error');
		expect(lane?.terminalResult?.result.workflowLaneFailureClass).toBe(
			'contract',
		);
		expect(lane?.terminalResult?.result.prReviewResultReceipt).toBeUndefined();
		expect(lane?.terminalResult?.result.error).toContain('degraded output');
	});

	test('a degraded-output terminal with a receipt on the record is NOT refused (typed failure persists)', async () => {
		const leg = await seedOpenLane(true);
		const claim = await claimTerminalResult(
			directory,
			leg.child,
			staleTerminal({
				child: leg.child,
				error: 'discovery validation failed on degraded output',
				failureClass: 'contract',
				outputDegraded: true,
			}),
		);
		// Not refused: the degraded terminal is a genuine content-integrity
		// failure, so it claims normally and the merged receipt rides along
		// while the typed class is preserved.
		expect(claim?.disposition).toBe('claimed');
		const lane = findByCorrelationId(directory, leg.child);
		expect(lane?.status).toBe('error');
		expect(lane?.terminalResult?.result.workflowLaneFailureClass).toBe(
			'contract',
		);
		expect(lane?.terminalResult?.result.prReviewResultReceipt).toBeDefined();
	});

	test('a non-binding receipt never flips the stale terminal (identity conflict)', async () => {
		const leg = await seedOpenLane(false);
		await claimStaleTerminalFirst(leg);
		const foreign = {
			...leg.receipt,
			baseSha: 'f'.repeat(40),
		} as never;
		const published = await publishLegReceipt(leg, foreign);
		expect(published.status).toBe('conflict');
		const lane = findByCorrelationId(directory, leg.child);
		expect(lane?.status).toBe('error');
		expect(lane?.terminalResult?.result.prReviewResultReceipt).toBeUndefined();
	});

	test('a publish onto an error/liveness terminal is still rejected (parent-repair lever unchanged)', async () => {
		const leg = await seedOpenLane(false);
		const claimed = await claimTerminalResult(
			directory,
			leg.child,
			staleTerminal({
				child: leg.child,
				error: 'lane presumed stale by the 30-minute sweep',
				failureClass: 'liveness',
			}),
		);
		expect(claimed?.disposition).toBe('claimed');
		const published = await publishLegReceipt(leg);
		expect(published.status).toBe('terminal');
		const lane = findByCorrelationId(directory, leg.child);
		expect(lane?.status).toBe('error');
		expect(lane?.result?.prReviewResultReceipt).toBeUndefined();
	});
});
