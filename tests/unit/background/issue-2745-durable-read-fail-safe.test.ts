/**
 * Durable-read fail-safe regressions for the #2745 review round.
 *
 * The queue sidecar and its primary can exist in any combination after a
 * crash between the two writes, and a loop-state file written by an older
 * shape (or corrupted) must normalize/fail closed instead of crashing reads.
 */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	claimPrFeedbackMonitorEvents,
	_internals as queueInternals,
	readPrFeedbackMonitorQueue,
	releasePrFeedbackMonitorEventClaim,
} from '../../../src/background/pr-feedback-event-queue.js';
import { _internals as loopInternals } from '../../../src/background/pr-feedback-loop.js';
import { acquirePrFeedbackQueueLease } from '../../../tests/helpers/pr-feedback-queue-lease';
import {
	CORRELATION,
	createCorrelation,
	enqueue,
	makeProject,
	readState,
	SESSION,
	writeState,
} from './issue-2745-state-safety-fixtures';

const originalQueueIsProcessAlive = queueInternals.isProcessAlive;

function queueTest(name: string, work: () => Promise<void>): void {
	test(name, async () => {
		const releaseQueue = await acquirePrFeedbackQueueLease();
		try {
			await work();
		} finally {
			queueInternals.isProcessAlive = originalQueueIsProcessAlive;
			queueInternals.resetQueueCache();
			releaseQueue();
		}
	});
}

// The _internals path helpers return paths relative to `.swarm/`; the swarm
// prefix is applied by validateSwarmPath inside the module.
function primaryPath(dir: string): string {
	return path.join(dir, '.swarm', queueInternals.queueRelativePath(SESSION));
}

function metadataPath(dir: string): string {
	return path.join(
		dir,
		'.swarm',
		queueInternals.queueMetadataRelativePath(SESSION),
	);
}

queueTest(
	'a claimed event reads with extended fields while both files exist',
	async () => {
		const directory = makeProject();
		await enqueue(directory, { dedupToken: 'window-a' });
		const claimed = await claimPrFeedbackMonitorEvents(
			directory,
			SESSION,
			'workflow-window-a',
			'https://github.com/example/repo/pull/42',
			['window-a'],
			42_424,
		);
		expect(claimed).toHaveLength(1);

		const record = await readPrFeedbackMonitorQueue(directory, SESSION);
		expect(record?.events[0]).toMatchObject({
			dedupToken: 'window-a',
			claimedOwnerPid: 42_424,
		});
	},
);

queueTest(
	'a missing sidecar reads the v1 record with safe defaults',
	async () => {
		const directory = makeProject();
		await enqueue(directory, { dedupToken: 'window-b' });
		await claimPrFeedbackMonitorEvents(
			directory,
			SESSION,
			'workflow-window-b',
			'https://github.com/example/repo/pull/42',
			['window-b'],
			42_424,
		);
		fs.rmSync(metadataPath(directory));
		// Bypass the in-memory write cache so the read reflects the disk state.
		queueInternals.resetQueueCache();

		const record = await readPrFeedbackMonitorQueue(directory, SESSION);
		expect(record).not.toBeNull();
		expect(record?.events[0]?.dedupToken).toBe('window-b');
		// Only the #2745-extended fields are sidecar-only; the v1 claim identity
		// stays in the primary record.
		expect(record?.events[0]?.claimedOwnerPid).toBeUndefined();
		expect(record?.events[0]?.headRefOid).toBeUndefined();
		expect(record?.events[0]?.claimedWorkflowInstanceId).toBe(
			'workflow-window-b',
		);
	},
);

queueTest(
	'a missing primary reads as an absent queue without throwing',
	async () => {
		const directory = makeProject();
		await enqueue(directory, { dedupToken: 'window-c' });
		await claimPrFeedbackMonitorEvents(
			directory,
			SESSION,
			'workflow-window-c',
			'https://github.com/example/repo/pull/42',
			['window-c'],
			42_424,
		);
		expect(fs.existsSync(metadataPath(directory))).toBe(true);
		fs.rmSync(primaryPath(directory));
		queueInternals.resetQueueCache();

		const record = await readPrFeedbackMonitorQueue(directory, SESSION);
		expect(record).toBeNull();
	},
);

queueTest(
	'a stale sidecar does not resurrect cleared claim fields',
	async () => {
		const directory = makeProject();
		await enqueue(directory, { dedupToken: 'window-d' });
		const claimed = await claimPrFeedbackMonitorEvents(
			directory,
			SESSION,
			'workflow-window-d',
			'https://github.com/example/repo/pull/42',
			['window-d'],
			42_424,
		);
		expect(claimed).toHaveLength(1);

		// The exact-owner release rewrites the primary (revision bump) while the
		// sidecar keeps its older revision: the merge must discard it.
		expect(
			await releasePrFeedbackMonitorEventClaim(
				directory,
				SESSION,
				'window-d',
				'workflow-window-d',
				42_424,
			),
		).toBe(true);
		expect(fs.existsSync(metadataPath(directory))).toBe(true);
		// Read from disk, not the write cache, to prove the stale sidecar itself
		// is discarded.
		queueInternals.resetQueueCache();

		const record = await readPrFeedbackMonitorQueue(directory, SESSION);
		expect(record).not.toBeNull();
		expect(record?.events[0]?.claimedOwnerPid).toBeUndefined();
		expect(record?.events[0]?.claimedWorkflowInstanceId).toBeUndefined();
	},
);

test('a corrupt loop-state file reads as corrupt instead of crashing', async () => {
	const directory = makeProject();
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'pr-feedback-loop-state.json'),
		'not-json',
		'utf8',
	);
	expect(await loopInternals.readState(directory)).toEqual({
		corrupt: true,
	});
});

test('a loop-state correlation missing new fields normalizes without crashing', async () => {
	const directory = makeProject();
	await enqueue(directory, { dedupToken: 'legacy-seed' });
	// Produce a real state file through the production pipeline.
	await createCorrelation(directory);

	const state = readState(directory);
	const correlation = state.correlations[CORRELATION];
	expect(correlation).toBeDefined();
	// Strip the #2745-era bookkeeping fields and re-read: the normalizer must
	// rebuild safe defaults rather than throw on the reduced shape.
	delete correlation.inFlight;
	delete correlation.revision;
	writeState(directory, state);

	const normalized = await loopInternals.readState(directory);
	expect(normalized).not.toEqual({ corrupt: true });
	expect(
		(normalized as { correlations: Record<string, unknown> }).correlations[
			CORRELATION
		],
	).toBeDefined();
});
