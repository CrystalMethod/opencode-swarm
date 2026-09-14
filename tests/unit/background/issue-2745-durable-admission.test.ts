/**
 * Durable reservation identity regressions for issue #2745.
 *
 * The action queue and loop state are separate durable records. These tests
 * pin that a reservation owner is the workflow/PID pair, not a timestamp or a
 * stale whole-correlation snapshot.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	claimPrFeedbackMonitorEvents,
	_internals as queueInternals,
	readPrFeedbackMonitorQueue,
	releasePrFeedbackMonitorEventClaim,
} from '../../../src/background/pr-feedback-event-queue.js';
import {
	cancelPrFeedbackLoop,
	claimAndProcessPrFeedbackEvent,
	_internals as loopInternals,
} from '../../../src/background/pr-feedback-loop.js';
import {
	acquireLoopInternals,
	CORRELATION,
	createCorrelation,
	enqueue,
	HEAD,
	installHappySeams,
	makeProject,
	readState,
	restoreProductionLoopInternals,
	SESSION,
	writeState,
} from './issue-2745-state-safety-fixtures';

function putInFlight(
	directory: string,
	reservation: Record<string, unknown>,
): void {
	const state = readState(directory);
	state.correlations[CORRELATION].inFlight = reservation;
	writeState(directory, state);
}

let releaseLoopInternals!: () => void;
const originalQueueIsProcessAlive = queueInternals.isProcessAlive;

beforeEach(async () => {
	releaseLoopInternals = await acquireLoopInternals();
});

function reservation(overrides: Record<string, unknown> = {}) {
	return {
		dedupToken: 'foreign-token',
		workflowInstanceId: 'foreign-workflow',
		ownerPid: process.pid,
		actionClass: 'fix_ci',
		head: HEAD,
		performed: false,
		attempts: 0,
		claimedAt: new Date(0).toISOString(),
		actionStartedAt: Date.now(),
		...overrides,
	};
}

test('queue release requires the exact workflow and owner PID pair', async () => {
	const directory = makeProject();
	await enqueue(directory, { dedupToken: 'owner-pair' });
	const claimed = await claimPrFeedbackMonitorEvents(
		directory,
		SESSION,
		'workflow-owner-pair',
		'https://github.com/example/repo/pull/42',
		['owner-pair'],
		42_424,
	);
	expect(claimed).toHaveLength(1);
	expect(claimed[0]).toMatchObject({
		claimedWorkflowInstanceId: 'workflow-owner-pair',
		claimedOwnerPid: 42_424,
	});

	expect(
		await releasePrFeedbackMonitorEventClaim(
			directory,
			SESSION,
			'owner-pair',
			'workflow-owner-pair',
			42_425,
		),
	).toBe(false);
	expect(
		(await readPrFeedbackMonitorQueue(directory, SESSION))?.events[0]
			?.claimedOwnerPid,
	).toBe(42_424);
	expect(
		await releasePrFeedbackMonitorEventClaim(
			directory,
			SESSION,
			'owner-pair',
			'workflow-owner-pair',
			42_424,
		),
	).toBe(true);
	expect(
		(await readPrFeedbackMonitorQueue(directory, SESSION))?.events[0]
			?.claimedWorkflowInstanceId,
	).toBeUndefined();
});

test('reclaims only the selected event from a demonstrably dead queue owner', async () => {
	const directory = makeProject();
	await enqueue(directory, { dedupToken: 'dead-queue-claim' });
	await enqueue(directory, { dedupToken: 'unselected-queue-claim' });
	const initiallyClaimed = await claimPrFeedbackMonitorEvents(
		directory,
		SESSION,
		'crashed-worker',
		'https://github.com/example/repo/pull/42',
		['dead-queue-claim'],
		42_424,
	);
	expect(initiallyClaimed).toHaveLength(1);

	queueInternals.isProcessAlive = () => false;
	const reclaimed = await claimPrFeedbackMonitorEvents(
		directory,
		SESSION,
		'restarted-worker',
		'https://github.com/example/repo/pull/42',
		['dead-queue-claim'],
		42_425,
	);

	expect(reclaimed).toHaveLength(1);
	expect(reclaimed[0]).toMatchObject({
		dedupToken: 'dead-queue-claim',
		claimedWorkflowInstanceId: 'restarted-worker',
		claimedOwnerPid: 42_425,
	});
	const queue = await readPrFeedbackMonitorQueue(directory, SESSION);
	expect(
		queue?.events.find((entry) => entry.dedupToken === 'unselected-queue-claim')
			?.claimedWorkflowInstanceId,
	).toBeUndefined();
});

test('does not reclaim a queue claim owned by a live PID', async () => {
	const directory = makeProject();
	await enqueue(directory, { dedupToken: 'live-queue-claim' });
	await claimPrFeedbackMonitorEvents(
		directory,
		SESSION,
		'live-worker',
		'https://github.com/example/repo/pull/42',
		['live-queue-claim'],
		42_424,
	);
	queueInternals.isProcessAlive = () => true;

	const attempted = await claimPrFeedbackMonitorEvents(
		directory,
		SESSION,
		'other-worker',
		'https://github.com/example/repo/pull/42',
		['live-queue-claim'],
		42_425,
	);

	expect(attempted).toEqual([]);
	expect(
		(await readPrFeedbackMonitorQueue(directory, SESSION))?.events[0],
	).toMatchObject({
		claimedWorkflowInstanceId: 'live-worker',
		claimedOwnerPid: 42_424,
	});
});

test('does not reclaim a legacy queue claim without a PID', async () => {
	const directory = makeProject();
	await enqueue(directory, { dedupToken: 'legacy-queue-claim' });
	const queue = await readPrFeedbackMonitorQueue(directory, SESSION);
	const firstEvent = queue?.events[0];
	expect(firstEvent).toBeDefined();
	const legacyEvent = {
		...firstEvent,
		claimedWorkflowInstanceId: 'legacy-worker',
		claimedAt: new Date(0).toISOString(),
	};
	delete legacyEvent.claimedOwnerPid;
	fs.writeFileSync(
		path.join(directory, '.swarm', queueInternals.queueRelativePath(SESSION)),
		JSON.stringify({ ...queue, events: [legacyEvent] }),
		'utf8',
	);
	queueInternals.resetQueueCache();
	queueInternals.isProcessAlive = () => false;

	const attempted = await claimPrFeedbackMonitorEvents(
		directory,
		SESSION,
		'restarted-worker',
		'https://github.com/example/repo/pull/42',
		['legacy-queue-claim'],
		42_425,
	);

	expect(attempted).toEqual([]);
	expect(
		(await readPrFeedbackMonitorQueue(directory, SESSION))?.events[0],
	).toMatchObject({
		claimedWorkflowInstanceId: 'legacy-worker',
	});
	expect(
		(await readPrFeedbackMonitorQueue(directory, SESSION))?.events[0]
			?.claimedOwnerPid,
	).toBeUndefined();
});

test('a live cross-process reservation returns retryable busy and releases only its claim', async () => {
	const directory = makeProject();
	await createCorrelation(directory);
	putInFlight(directory, reservation());
	const seams = installHappySeams();
	await enqueue(directory, {
		dedupToken: 'busy-token',
		type: 'pr.merge.conflict',
	});

	const result = await claimAndProcessPrFeedbackEvent(directory, SESSION);

	expect(result.reason).toMatch(/retryable.*busy/i);
	expect(seams.performer).not.toHaveBeenCalled();
	const queue = await readPrFeedbackMonitorQueue(directory, SESSION);
	expect(
		queue?.events.find((entry) => entry.dedupToken === 'busy-token')
			?.claimedWorkflowInstanceId,
	).toBeUndefined();
	expect(readState(directory).correlations[CORRELATION].inFlight).toMatchObject(
		{
			workflowInstanceId: 'foreign-workflow',
			ownerPid: process.pid,
		},
	);
});

test('final admission counts live reservations from every PR in the session budget', async () => {
	const directory = makeProject();
	await createCorrelation(directory);
	fs.writeFileSync(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			pr_monitor: { enabled: true, auto_pr_feedback: true },
			pr_feedback_loop: { enabled: true, max_session_actions: 2 },
		}),
		'utf8',
	);
	const state = readState(directory);
	state.correlations[`${SESSION}::example/repo::43`] = {
		revision: 1,
		sessionID: SESSION,
		repoFullName: 'example/repo',
		prNumber: 43,
		prActionsUsed: 0,
		processedDigests: [],
		circuit: { failures: 0, openUntil: 0, halfOpenProbes: 0 },
		inFlight: reservation({
			dedupToken: 'other-pr',
			workflowInstanceId: 'other-pr-worker',
			actionStartedAt: undefined,
		}),
		terminal: null,
	};
	writeState(directory, state);
	const seams = installHappySeams();
	await enqueue(directory, {
		dedupToken: 'session-capacity',
		type: 'pr.merge.conflict',
	});

	const result = await claimAndProcessPrFeedbackEvent(directory, SESSION);
	expect(result.reason).toMatch(/retryable.*capacity/i);
	expect(seams.performer).not.toHaveBeenCalled();
	const queue = await readPrFeedbackMonitorQueue(directory, SESSION);
	expect(
		queue?.events.find((entry) => entry.dedupToken === 'session-capacity')
			?.claimedWorkflowInstanceId,
	).toBeUndefined();
});

test('a dead owner is recoverable only before the action-started marker', async () => {
	const directory = makeProject();
	await createCorrelation(directory);
	putInFlight(
		directory,
		reservation({
			workflowInstanceId: 'dead-before-start',
			ownerPid: 42_424,
			actionStartedAt: undefined,
		}),
	);
	const seams = installHappySeams();
	loopInternals.isProcessAlive = mock(() => false);
	await enqueue(directory, {
		dedupToken: 'recover-dead',
		type: 'pr.merge.conflict',
	});

	const result = await claimAndProcessPrFeedbackEvent(directory, SESSION);

	expect(result.terminal?.state).toBe('completed');
	expect(seams.performer).toHaveBeenCalledTimes(1);
});

test('a dead owner after actionStartedAt remains counted and blocks recovery', async () => {
	const directory = makeProject();
	await createCorrelation(directory);
	putInFlight(
		directory,
		reservation({
			workflowInstanceId: 'dead-after-start',
			ownerPid: 42_424,
			actionStartedAt: Date.now(),
		}),
	);
	const seams = installHappySeams();
	loopInternals.isProcessAlive = mock(() => false);
	await enqueue(directory, {
		dedupToken: 'dead-started',
		type: 'pr.merge.conflict',
	});

	const result = await claimAndProcessPrFeedbackEvent(directory, SESSION);

	expect(result.reason).toMatch(/retryable.*busy/i);
	expect(seams.performer).not.toHaveBeenCalled();
	expect(readState(directory).correlations[CORRELATION].inFlight).toMatchObject(
		{
			workflowInstanceId: 'dead-after-start',
			ownerPid: 42_424,
		},
	);
});

test('a late result cannot settle over a replacement reservation owner', async () => {
	const directory = makeProject();
	await createCorrelation(directory);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const seams = installHappySeams();
	loopInternals.performAuthorizedAction = mock(async () => {
		await gate;
		return { performed: true };
	}) as unknown as typeof loopInternals.performAuthorizedAction;
	await enqueue(directory, {
		dedupToken: 'late-owner-result',
		type: 'pr.merge.conflict',
	});
	const processing = claimAndProcessPrFeedbackEvent(directory, SESSION);
	for (let attempt = 0; attempt < 80; attempt++) {
		if (loopInternals.performAuthorizedAction.mock.calls.length > 0) break;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	expect(loopInternals.performAuthorizedAction).toHaveBeenCalledTimes(1);
	putInFlight(
		directory,
		reservation({
			workflowInstanceId: 'replacement-owner',
			ownerPid: 42_424,
			actionStartedAt: undefined,
		}),
	);
	release();

	const result = await processing;

	expect(result.action?.performed).toBe(true);
	expect(result.terminal?.state).toBe('paused_for_human');
	expect(result.terminal?.reason).toMatch(
		/lost its exact durable reservation owner/i,
	);
	expect(seams.performer).not.toHaveBeenCalled();
	expect(readState(directory).correlations[CORRELATION].inFlight).toMatchObject(
		{
			workflowInstanceId: 'replacement-owner',
			ownerPid: 42_424,
		},
	);
});

test('legacy ownerless inFlight state fails closed instead of using age recovery', async () => {
	const directory = makeProject();
	await createCorrelation(directory);
	putInFlight(
		directory,
		reservation({
			workflowInstanceId: undefined,
			ownerPid: undefined,
			actionStartedAt: undefined,
		}),
	);
	const seams = installHappySeams();
	await enqueue(directory, {
		dedupToken: 'legacy-ownerless',
		type: 'pr.merge.conflict',
	});

	const result = await claimAndProcessPrFeedbackEvent(directory, SESSION);

	expect(result.reason).toMatch(/retryable.*busy/i);
	expect(seams.performer).not.toHaveBeenCalled();
});

test('correlation CAS revisions increase across durable cancellation and remain monotonic', async () => {
	const directory = makeProject();
	await createCorrelation(directory);
	const before = readState(directory).correlations[CORRELATION].revision;

	const stopped = await cancelPrFeedbackLoop(
		directory,
		SESSION,
		'revision stop',
	);

	const after = readState(directory).correlations[CORRELATION].revision;
	expect(stopped.terminalState).toBe('cancelled');
	expect(after).toBeGreaterThan(before);

	const stoppedAgain = await cancelPrFeedbackLoop(
		directory,
		SESSION,
		'another reason',
	);
	const finalRevision = readState(directory).correlations[CORRELATION].revision;
	expect(stoppedAgain.terminalState).toBe('cancelled');
	expect(finalRevision).toBeGreaterThanOrEqual(after);
});

afterEach(() => {
	try {
		restoreProductionLoopInternals();
		queueInternals.isProcessAlive = originalQueueIsProcessAlive;
		queueInternals.resetQueueCache();
	} finally {
		releaseLoopInternals();
	}
});
