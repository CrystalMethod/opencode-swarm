/**
 * Issue #2745 activation-capacity and cancellation-saturation regressions.
 *
 * These cases are kept separate from the general admission barriers so the
 * high-cardinality coordination coverage stays below the test-file cap.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	enqueuePrFeedbackMonitorEvent,
	_internals as queueInternals,
	readPrFeedbackMonitorQueue,
} from '../../../src/background/pr-feedback-event-queue.js';
import {
	cancelPrFeedbackLoop,
	claimAndProcessPrFeedbackEvent,
	_internals as loopInternals,
} from '../../../src/background/pr-feedback-loop.js';
import {
	subscribe,
	updateSnapshot,
} from '../../../src/background/pr-subscriptions.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { _test_exports as gateInternals } from '../../../src/hooks/pr-workflow-gate.js';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir';

const SESSION = 'issue-2745-session';
const REPO = 'example/repo';
const PR = 42;
const URL = 'https://github.com/example/repo/pull/42';
const HEAD = 'head-1';
const CONFIG = {
	pr_monitor: { enabled: true, auto_pr_feedback: true },
	pr_feedback_loop: { enabled: true },
};
const originals = { ...loopInternals };
const oldXdg = process.env.XDG_CONFIG_HOME;
const dirs: string[] = [];

beforeAll(() => {
	const xdg = canonicalMkdtemp('issue-2745-capacity-xdg-');
	dirs.push(xdg);
	process.env.XDG_CONFIG_HOME = xdg;
});

afterAll(() => {
	if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = oldXdg;
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	queueInternals.resetQueueCache();
	gateInternals.resetTrackedStateCache();
});

afterEach(() => {
	Object.assign(loopInternals, originals);
	queueInternals.resetQueueCache();
	gateInternals.resetTrackedStateCache();
	closeAllProjectDbs();
	for (const dir of dirs.splice(1))
		fs.rmSync(dir, { recursive: true, force: true });
});

function makeProject(): string {
	const dir = canonicalMkdtemp('issue-2745-capacity-proj-');
	dirs.push(dir);
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(CONFIG),
		'utf8',
	);
	return dir;
}

async function prime(dir: string, sessionID = SESSION): Promise<void> {
	await subscribe(dir, {
		sessionID,
		prNumber: PR,
		repoFullName: REPO,
		prUrl: URL,
	});
	await updateSnapshot(dir, `${sessionID}::${REPO}::${PR}`, {
		headRefOid: HEAD,
	});
}

async function enqueue(
	dir: string,
	options: {
		dedupToken?: string;
		authorized?: boolean;
		sessionID?: string;
	} = {},
): Promise<void> {
	await enqueuePrFeedbackMonitorEvent(dir, options.sessionID ?? SESSION, {
		type: 'pr.ci.failed',
		repoFullName: REPO,
		prNumber: PR,
		prUrl: URL,
		message: 'ci failed',
		dedupToken: options.dedupToken ?? 'token',
		authorized: options.authorized ?? true,
		queuedAt: new Date(0).toISOString(),
	});
}

function installHappySeams(): ReturnType<typeof mock> {
	loopInternals.evaluateCurrentHead = mock(
		async () => HEAD,
	) as unknown as typeof loopInternals.evaluateCurrentHead;
	loopInternals.dispatchOversight = mock(async () => ({
		dispatched: true,
		decision: 'allow',
	}));
	const performer = mock(async () => ({ performed: true }));
	loopInternals.performAuthorizedAction =
		performer as unknown as typeof loopInternals.performAuthorizedAction;
	return performer;
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 80; attempt++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('test condition did not become ready');
}

describe('issue #2745 cancellation admission barrier — capacity regressions', () => {
	test('cancellation overflow fails closed without evicting active stops', async () => {
		const blockedDirs = Array.from({ length: 65 }, () => makeProject());
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reads = 0;
		let markReady!: () => void;
		const ready = new Promise<void>((resolve) => {
			markReady = resolve;
		});
		loopInternals.readState = mock(async () => {
			reads += 1;
			if (reads === blockedDirs.length) markReady();
			await gate;
			return {
				schemaVersion: 1,
				updatedAt: new Date(0).toISOString(),
				oversightSeq: 0,
				correlations: {},
				sessionTerminals: {},
			};
		}) as unknown as typeof loopInternals.readState;
		const stops = blockedDirs.map((dir, index) =>
			cancelPrFeedbackLoop(dir, `overflow-session-${index}`, 'overflow stop'),
		);
		await ready;

		const dirAfterOverflow = makeProject();
		const performer = installHappySeams();
		const blocked = await claimAndProcessPrFeedbackEvent(
			dirAfterOverflow,
			'overflow-admission-session',
		);

		expect(blocked.reason).toMatch(
			/cancellation admission capacity exhausted/i,
		);
		// Prior bug (R1): registry overflow was reported as a fabricated
		// operator cancellation and could overwrite a completed action.
		expect(blocked.terminal).toBeNull();
		expect(performer).not.toHaveBeenCalled();
		release();
		await Promise.all(stops);
	});

	test('active action stop stays targeted when ordinary cancellation registry is full', async () => {
		const activeDir = makeProject();
		const activeSession = 'active-stop';
		await prime(activeDir, activeSession);
		await enqueue(activeDir, { sessionID: activeSession });
		let headStarted = false;
		let releaseHead!: () => void;
		const headGate = new Promise<void>((resolve) => {
			releaseHead = resolve;
		});
		loopInternals.evaluateCurrentHead = mock(async () => {
			headStarted = true;
			await headGate;
			return HEAD;
		}) as unknown as typeof loopInternals.evaluateCurrentHead;
		loopInternals.dispatchOversight = mock(async () => ({
			dispatched: true,
			decision: 'allow',
		})) as unknown as typeof loopInternals.dispatchOversight;
		const performer = mock(async () => ({ performed: true }));
		loopInternals.performAuthorizedAction =
			performer as unknown as typeof loopInternals.performAuthorizedAction;
		const processing = claimAndProcessPrFeedbackEvent(activeDir, activeSession);
		await waitFor(() => headStarted);

		let reads = 0;
		let markSaturated!: () => void;
		const saturated = new Promise<void>((resolve) => {
			markSaturated = resolve;
		});
		let releaseReads!: () => void;
		const readsGate = new Promise<void>((resolve) => {
			releaseReads = resolve;
		});
		loopInternals.readState = mock(async () => {
			reads += 1;
			if (reads === 64) markSaturated();
			await readsGate;
			return {
				schemaVersion: 1,
				updatedAt: new Date(0).toISOString(),
				oversightSeq: 0,
				correlations: {},
				sessionTerminals: {},
			};
		}) as unknown as typeof loopInternals.readState;
		const ordinaryDirs = Array.from({ length: 64 }, () => makeProject());
		const ordinaryStops = ordinaryDirs.map((dir, index) =>
			cancelPrFeedbackLoop(dir, `ordinary-${index}`, 'ordinary stop'),
		);
		await saturated;

		const targetedStop = cancelPrFeedbackLoop(
			activeDir,
			activeSession,
			'targeted stop',
		);
		releaseHead();
		releaseReads();
		const [result] = await Promise.all([processing, targetedStop]);
		await Promise.all(ordinaryStops);

		// The targeted active stop remains effective even when unrelated
		// cancellation requests fill the bounded registry.
		expect(result.terminal?.state).toBe('cancelled');
		expect(result.reason).toMatch(/cancelled: targeted stop/);
		expect(performer).not.toHaveBeenCalled();
	});

	test('leaves the 65th action unclaimed, admits a stop, and retries after capacity frees', async () => {
		const sessions = Array.from({ length: 64 }, (_, index) => `busy-${index}`);
		const busyDirs = sessions.map(() => makeProject());
		let started = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		loopInternals.evaluateCurrentHead = mock(async () => {
			started += 1;
			await gate;
			return HEAD;
		}) as unknown as typeof loopInternals.evaluateCurrentHead;
		loopInternals.dispatchOversight = mock(async () => ({
			dispatched: true,
			decision: 'allow',
		}));
		loopInternals.performAuthorizedAction = mock(async () => ({
			performed: true,
		}));
		for (const [index, sessionID] of sessions.entries()) {
			const busyDir = busyDirs[index]!;
			await prime(busyDir, sessionID);
			await enqueue(busyDir, { dedupToken: `token-${sessionID}`, sessionID });
		}
		const busy = sessions.map((sessionID, index) =>
			claimAndProcessPrFeedbackEvent(busyDirs[index]!, sessionID),
		);
		for (
			let attempt = 0;
			attempt < 1000 && started !== sessions.length;
			attempt++
		) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		if (started !== sessions.length) {
			release();
			await Promise.allSettled(busy);
			throw new Error(
				'settlement capacity did not fill within the bounded wait',
			);
		}

		const dir = makeProject();
		const retrySession = 'retry-after-capacity';
		await prime(dir, retrySession);
		await enqueue(dir, { dedupToken: 'retry-token', sessionID: retrySession });
		const blocked = await claimAndProcessPrFeedbackEvent(dir, retrySession);
		expect(blocked.reason).toMatch(/settlement capacity exhausted/i);
		expect(started).toBe(sessions.length);
		expect(
			(await readPrFeedbackMonitorQueue(dir, retrySession))?.events[0]
				?.claimedWorkflowInstanceId,
		).toBeUndefined();

		// A same-key cancellation replaces the serialization tail while the
		// action is still evaluating. It must not remove that action key from
		// the independent capacity accounting.
		const tailCancellation = cancelPrFeedbackLoop(
			busyDirs[0]!,
			sessions[0]!,
			'tail stop',
		);
		const blockedAfterTail = await claimAndProcessPrFeedbackEvent(
			dir,
			retrySession,
		);
		expect(blockedAfterTail.reason).toMatch(/settlement capacity exhausted/i);

		const stopped = await cancelPrFeedbackLoop(
			dir,
			'cancel-at-capacity',
			'stop',
		);
		expect(stopped.terminalState).toBe('cancelled');
		release();
		await Promise.all(busy);
		await tailCancellation;

		const retried = await claimAndProcessPrFeedbackEvent(dir, retrySession);
		expect(retried.action?.performed).toBe(true);
	});
});
