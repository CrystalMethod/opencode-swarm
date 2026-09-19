/**
 * Issue #2700 (AC2) — the architect-parent repair publish leaves the lane
 * record observably carrying its typed terminal result the moment the publish
 * settles: an EVENTLESS liveness-terminal lane (the pre-#2700 sweep/idle
 * shapes, including legacy stores) gets its typed event backfilled atomically
 * with the receipt; an already-typed lane keeps its original event untouched;
 * a replay publish stays `duplicate` with no second backfill; and a
 * non-liveness terminal still refuses the parent-repair admission.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	appendDelegationTransition,
	BACKGROUND_DELEGATIONS_FILE,
	buildBackgroundCompletionEventId,
	claimTerminalResult,
	findByCorrelationId,
	publishPrReviewResultReceipt,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import {
	encodePrReviewWorkflowBinding,
	type PrReviewLaneResultEnvelope,
	prReviewLaneResultEnvelopeDigest,
} from '../../../src/background/pr-review-contract';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { dir, cleanup } = createSafeTestDir('swarm-bg-2700-repair-');
afterEach(cleanup);
beforeEach(() => {
	fs.rmSync(path.join(dir, '.swarm'), { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const INSTANCE = 'wf-2700-repair';
const BATCH = 'batch-2700-repair';
const LANE = 'lane-2700-repair';
const DIMENSION = 'compatibility-delivery';
const EMPTY_DIGEST = createHash('sha256').update('').digest('hex');

async function seedLane(correlationId: string): Promise<void> {
	await recordPendingDelegation(dir, {
		correlationId,
		jobId: encodePrReviewWorkflowBinding(INSTANCE),
		subagentSessionId: correlationId,
		parentSessionId: 'ses_parent_2700',
		callID: `call-${correlationId}`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: BATCH,
		laneId: LANE,
		mode: 'swarm-pr-review:base',
		workflowLane: DIMENSION,
		workflowGeneration: 1,
		generation: 1,
		workspace: {
			directory: dir,
			gitHead: HEAD,
			dirtyHash: null,
			prHeadSha: HEAD,
			scope: null,
		},
	});
}

/**
 * Seed a LEGACY-STORE: the exact single-row shape an older plugin version
 * left behind (terminal status + liveness class on `result`, no typed
 * `terminalResult`). Written as the store's INITIAL state before any current
 * writer runs, so the coordination import ingests it verbatim — appending a
 * legacy row after a current writer would leave the coordination shadow
 * stale. No current writer produces this shape anymore — that is the #2700
 * fix — so the backfill's legacy arm can only be exercised by replaying
 * old-version data.
 */
async function seedLegacyEventlessStale(correlationId: string): Promise<void> {
	const legacyReason =
		'lane presumed stale after 1800000ms without a terminal event';
	const legacyRow = {
		schemaVersion: 2,
		correlationId,
		jobId: encodePrReviewWorkflowBinding(INSTANCE),
		subagentSessionId: correlationId,
		parentSessionId: 'ses_parent_2700',
		callID: `call-${correlationId}`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: BATCH,
		laneId: LANE,
		mode: 'swarm-pr-review:base',
		workflowLane: DIMENSION,
		workflowGeneration: 1,
		generation: 1,
		workspace: {
			directory: dir,
			gitHead: HEAD,
			dirtyHash: null,
			prHeadSha: HEAD,
			scope: null,
		},
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_060_000_000,
		completedAt: 1_700_060_000_000,
		status: 'stale',
		result: {
			error: legacyReason,
			chars: legacyReason.length,
			truncated: false,
			digest: createHash('sha256').update(legacyReason).digest('hex'),
			workflowLaneFailureClass: 'liveness',
		},
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
		`${JSON.stringify(legacyRow)}
`,
	);
}

function incompleteEnvelope(): PrReviewLaneResultEnvelope {
	return {
		schemaVersion: 1,
		outcome: 'INCOMPLETE',
		creditedLanes: [],
		findings: [],
		cleanAttestations: [],
		unresolved: [
			{
				workflowLane: DIMENSION,
				reason: 'NOT_EXECUTED',
				detail: 'child died before submitting',
			},
		],
	};
}

async function publishRepair(
	correlationId: string,
	envelope: PrReviewLaneResultEnvelope,
) {
	return publishPrReviewResultReceipt(dir, {
		parentSessionId: 'ses_parent_2700',
		childSessionId: correlationId,
		batchId: BATCH,
		laneId: LANE,
		expectedWorkflowInstanceId: INSTANCE,
		expectedWorkflowRevision: 1,
		expectedBaseSha: BASE,
		parentRepair: true,
		receipt: {
			schemaVersion: 1,
			mode: 'swarm-pr-review:base',
			workflowInstanceId: INSTANCE,
			workflowRevision: 1,
			batchId: BATCH,
			laneId: LANE,
			workflowLane: DIMENSION,
			ownedWorkflowLanes: [DIMENSION],
			baseSha: BASE,
			headSha: HEAD,
			dispatchRevisionDigest: 'e'.repeat(64),
			childSessionId: correlationId,
			generation: 1,
			semanticEnvelopeDigest: prReviewLaneResultEnvelopeDigest(envelope),
			envelope,
			submittedBy: 'workflow_parent',
			submittedByParentSessionId: 'ses_parent_2700',
			laneTerminalStateAtSubmission: 'stale',
		},
	});
}

describe('issue #2700: repair publish typed-terminal backfill', () => {
	it('a publish onto an eventless liveness-terminal lane backfills the typed result atomically with the receipt', async () => {
		const id = 'ses_repair_backfill';
		await seedLegacyEventlessStale(id);
		expect(findByCorrelationId(dir, id)?.terminalResult).toBeUndefined();

		const published = await publishRepair(id, incompleteEnvelope());
		expect(published.status).toBe('recorded');
		const record = findByCorrelationId(dir, id);
		expect(record?.result?.prReviewResultReceipt).toBeDefined();
		const terminal = record?.terminalResult;
		expect(terminal?.status).toBe('stale');
		expect(terminal?.result.workflowLaneFailureClass).toBe('liveness');
		expect(terminal?.eventId).toBe(
			buildBackgroundCompletionEventId({
				correlationId: id,
				jobId: encodePrReviewWorkflowBinding(INSTANCE),
				status: 'stale',
				resultDigest: terminal?.result.digest,
			}),
		);
	});

	it('a publish onto an already-typed lane keeps the original typed event untouched', async () => {
		const id = 'ses_repair_typed';
		await seedLane(id);
		const claimed = await claimTerminalResult(dir, id, {
			eventId: buildBackgroundCompletionEventId({
				correlationId: id,
				jobId: encodePrReviewWorkflowBinding(INSTANCE),
				status: 'cancelled',
				resultDigest: EMPTY_DIGEST,
			}),
			status: 'cancelled',
			recordedAt: Date.now(),
			result: {
				error: 'lane cancelled via collect_lane_results cancel_pending',
				chars: 0,
				truncated: false,
				digest: EMPTY_DIGEST,
				workflowLaneFailureClass: 'liveness',
			},
		});
		expect(claimed?.disposition).toBe('claimed');
		const originalEventId = claimed?.record.terminalResult?.eventId;

		const published = await publishRepair(id, incompleteEnvelope());
		expect(published.status).toBe('recorded');
		expect(findByCorrelationId(dir, id)?.terminalResult?.eventId).toBe(
			originalEventId,
		);
	});

	it('a replay publish stays duplicate with no second backfill', async () => {
		const id = 'ses_repair_duplicate';
		await seedLegacyEventlessStale(id);
		await publishRepair(id, incompleteEnvelope());
		const first = findByCorrelationId(dir, id);

		const replay = await publishRepair(id, incompleteEnvelope());
		expect(replay.status).toBe('duplicate');
		const second = findByCorrelationId(dir, id);
		expect(second?.terminalResult?.eventId).toBe(
			first?.terminalResult?.eventId,
		);
		expect(second?.updatedAt).toBe(first?.updatedAt);
	});

	it('a non-liveness terminal still refuses the parent-repair admission', async () => {
		const id = 'ses_repair_refused';
		await seedLane(id);
		const flipped = await appendDelegationTransition(dir, id, {
			status: 'error',
			result: {
				error: 'resource exhausted at launch',
				chars: 28,
				truncated: false,
				digest: createHash('sha256')
					.update('resource exhausted at launch')
					.digest('hex'),
				workflowLaneFailureClass: 'resource',
			},
		});
		expect(flipped?.status).toBe('error');

		const published = await publishRepair(id, incompleteEnvelope());
		expect(published.status).toBe('terminal');
	});
});
