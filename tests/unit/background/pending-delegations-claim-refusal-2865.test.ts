/**
 * Issue #2865 regression: claim-point refusal of stale-decision contract
 * terminals.
 *
 * claimTerminalResult merges a receipt already recorded on the open record
 * into the PERSISTED terminal result without re-validating the decision that
 * produced the terminal. Pre-fix, an error terminal with
 * workflowLaneFailureClass 'contract' whose result lacked the receipt
 * (a settlement decided from a stale record snapshot) therefore persisted the
 * self-contradicting state: an error saying "missing structured receipt" next
 * to the valid receipt in the same record.
 *
 * The fix refuses exactly that signature under the store lock: the only
 * producer of an error+'contract' terminal is the PR-review collect settle
 * path, which includes its snapshot's receipt in the result whenever the
 * snapshot had one — so "error+contract result lacking a receipt the record
 * holds" can only be a stale decision. Refusing leaves the record open for
 * the next collection pass, which re-reads records at entry.
 *
 * Legs:
 *  - refusal: stale error/contract terminal refused; record stays open with
 *    the receipt.
 *  - idempotency: a second claim WITH the receipt in its result claims
 *    normally (the refused-then-refreshed settle cannot loop).
 *  - mismatched-receipt negative: a result that carries the receipt (the
 *    legitimate "mismatched structured receipt" rejection shape) is never
 *    refused.
 *  - liveness negative: an error+'liveness' stale terminal (no receipt in
 *    result, record holds one) is NOT refused; the merged receipt lands in
 *    the persisted terminal result as before.
 *  - end-to-end: settleDelegationTerminal classifies the refused claim as
 *    not_open for the still-open record (the re-read branch callers rely on).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { settleDelegationTerminal } from '../../../src/background/delegation-lifecycle.js';
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
const PARENT = 'claim-refusal-parent-2865';
const NOW = 2_000_000_000_000;

let directory = '';
let legIndex = 0;

beforeEach(() => {
	legIndex += 1;
	directory = canonicalMkdtemp(`claim-refusal-2865-${legIndex}-`);
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
				title: 'Claim-refusal regression finding',
				body: 'Receipt published before the stale terminal claim.',
				evidence: 'Store-level refusal probe.',
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

interface Leg {
	batchId: string;
	laneId: string;
	child: string;
	receipt: ReturnType<typeof buildReceipt>;
}

async function seedOpenLane(publish: boolean): Promise<Leg> {
	const suffix = `l${legIndex}`;
	const leg: Leg = {
		batchId: `claim-refusal-batch-${suffix}`,
		laneId: `claim-refusal-lane-${suffix}`,
		child: `claim-refusal-child-${suffix}`,
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
		promptHash: 'prompt-hash-2865-c2',
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

async function seedOpenLaneWithPublishedReceipt(): Promise<Leg> {
	return seedOpenLane(true);
}

async function seedOpenLaneWithoutPublishedReceipt(): Promise<Leg> {
	return seedOpenLane(false);
}

function staleTerminal(args: {
	child: string;
	error: string;
	failureClass: 'contract' | 'liveness';
	receipt?: unknown;
}) {
	const resultDigest = createHash('sha256').update(args.error).digest('hex');
	return {
		eventId: buildBackgroundCompletionEventId({
			correlationId: args.child,
			jobId: encodePrReviewWorkflowBinding(WORKFLOW_INSTANCE),
			status: 'error' as const,
			resultDigest,
		}),
		status: 'error' as const,
		recordedAt: NOW,
		result: {
			error: args.error,
			chars: args.error.length,
			truncated: false,
			digest: resultDigest,
			workflowLaneFailureClass: args.failureClass,
			...(args.receipt ? { prReviewResultReceipt: args.receipt } : {}),
		},
	};
}

const MISSING_RECEIPT_ERROR =
	'PR_REVIEW_DISCOVERY_CONTRACT_INVALID: predicate=discovery.coverage ' +
	'actual="missing structured receipt (legacy transcript adapter disabled)"';

describe('claim-point refusal of stale-decision contract terminals (#2865)', () => {
	test('refuses an error/contract terminal whose result lacks a receipt the record holds', async () => {
		const leg = await seedOpenLaneWithPublishedReceipt();
		const claim = await claimTerminalResult(
			directory,
			leg.child,
			staleTerminal({
				child: leg.child,
				error: MISSING_RECEIPT_ERROR,
				failureClass: 'contract',
			}),
		);
		expect(claim).toBeNull();
		const lane = findByCorrelationId(directory, leg.child);
		expect(lane?.status === 'pending' || lane?.status === 'running').toBe(true);
		expect(lane?.terminalResult).toBeUndefined();
		expect(lane?.result?.prReviewResultReceipt).toBeDefined();
	});

	test('a second claim WITH the receipt in its result claims normally (no loop)', async () => {
		const leg = await seedOpenLaneWithPublishedReceipt();
		const refused = await claimTerminalResult(
			directory,
			leg.child,
			staleTerminal({
				child: leg.child,
				error: MISSING_RECEIPT_ERROR,
				failureClass: 'contract',
			}),
		);
		expect(refused).toBeNull();
		// The refreshed settle carries the receipt it re-validated with; the
		// merge is then a no-op and the claim must proceed.
		const claimed = await claimTerminalResult(
			directory,
			leg.child,
			staleTerminal({
				child: leg.child,
				error:
					'PR_REVIEW_DISCOVERY_CONTRACT_INVALID: actual="mismatched structured receipt"',
				failureClass: 'contract',
				receipt: leg.receipt,
			}),
		);
		expect(claimed?.disposition).toBe('claimed');
		const lane = findByCorrelationId(directory, leg.child);
		expect(lane?.status).toBe('error');
		expect(lane?.terminalResult?.result.prReviewResultReceipt).toBeDefined();
	});

	test('a mismatched-receipt rejection (receipt in result) is never refused', async () => {
		const leg = await seedOpenLaneWithPublishedReceipt();
		const claimed = await claimTerminalResult(
			directory,
			leg.child,
			staleTerminal({
				child: leg.child,
				error:
					'PR_REVIEW_DISCOVERY_CONTRACT_INVALID: actual="mismatched structured receipt"',
				failureClass: 'contract',
				receipt: leg.receipt,
			}),
		);
		expect(claimed?.disposition).toBe('claimed');
		const lane = findByCorrelationId(directory, leg.child);
		expect(lane?.status).toBe('error');
		expect(lane?.terminalResult?.result.prReviewResultReceipt).toBeDefined();
	});

	test('an error/liveness stale terminal is NOT refused; the merge still lands', async () => {
		const leg = await seedOpenLaneWithPublishedReceipt();
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
		const lane = findByCorrelationId(directory, leg.child);
		expect(lane?.status).toBe('error');
		expect(lane?.terminalResult?.result.prReviewResultReceipt).toBeDefined();
		expect(lane?.terminalResult?.result.workflowLaneFailureClass).toBe(
			'liveness',
		);
	});

	test('settleDelegationTerminal classifies the refused claim as not_open for the open record', async () => {
		const leg = await seedOpenLaneWithPublishedReceipt();
		const record = findByCorrelationId(directory, leg.child);
		expect(record).toBeDefined();
		const outcome = await settleDelegationTerminal(
			directory,
			record!,
			{
				status: 'error',
				result: {
					error: MISSING_RECEIPT_ERROR,
					chars: MISSING_RECEIPT_ERROR.length,
					truncated: false,
					digest: createHash('sha256')
						.update(MISSING_RECEIPT_ERROR)
						.digest('hex'),
					workflowLaneFailureClass: 'contract',
				},
			},
			{},
			NOW,
		);
		expect(outcome.kind).toBe('not_open');
		const lane = findByCorrelationId(directory, leg.child);
		expect(lane?.status === 'pending' || lane?.status === 'running').toBe(true);
		expect(lane?.result?.prReviewResultReceipt).toBeDefined();
	});
});

describe('claim-first interleaving: a publish after a won claim settles the lane (#2865)', () => {
	// Scenario shared by these legs: the receipt is NOT published first — the
	// stale error/contract terminal claim wins the lock outright (the guard
	// cannot fire because no receipt exists under the lock at claim time), and
	// the child's exactly-bound publish arrives afterwards.
	async function claimStaleTerminalFirst(leg: Leg) {
		const claimed = await claimTerminalResult(
			directory,
			leg.child,
			staleTerminal({
				child: leg.child,
				error: MISSING_RECEIPT_ERROR,
				failureClass: 'contract',
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

	test('an exactly-bound receipt admitted after the won claim settles the record completed', async () => {
		const leg = await seedOpenLaneWithoutPublishedReceipt();
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
		// Idempotent: a replay of the same publish is a duplicate, not a flip.
		const replay = await publishLegReceipt(leg);
		expect(replay.status).toBe('duplicate');
		const after = findByCorrelationId(directory, leg.child);
		expect(after?.status).toBe('completed');
		expect(after?.result?.error).toBeUndefined();
	});

	test('a non-binding receipt never flips the stale terminal (identity conflict)', async () => {
		const leg = await seedOpenLaneWithoutPublishedReceipt();
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
		const leg = await seedOpenLaneWithoutPublishedReceipt();
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
