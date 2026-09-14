/**
 * Issue #2502 — PR feedback settling loop: claim → classify → authorize →
 * oversight → act → settle (the completion-fixture unit).
 *
 * Covers the PrFeedbackLoopConfigSchema shape, the disabled no-op, queue-empty,
 * the full settle (M4 completion-scope terminal reason), idempotent replay,
 * stale/foreign/unsupported/ambiguous refusals, the per-PR budget pause, the
 * transient-failure circuit (degraded) vs permanent failure (paused_for_human),
 * half-open probe recovery, and interrupted-settlement restoration.
 *
 * Isolation notes:
 * - NO mock.module: the loop's own `_internals` seam injects head evaluation,
 *   oversight dispatch, and the authorized-action performer. ALL overrides are
 *   restored in afterEach (originals captured at module top, Object.assign
 *   back). readState/writeState/now keep their real implementations except in
 *   the circuit tests, where `now` is pinned to a fixed T0.
 * - XDG_CONFIG_HOME is redirected to an empty temp dir for the whole file so
 *   loadPluginConfig's USER-config read cannot flip the triple gate on a
 *   machine whose ~/.config/opencode/opencode-swarm.json already sets
 *   pr_monitor.enabled + auto_pr_feedback (deterministic disabled paths).
 * - The seeded subscription is a REAL pr-subscriptions record (subscribe +
 *   updateSnapshot headRefOid 'h1') in a canonicalMkdtemp project root, so the
 *   loop's listActive foreign/stale checks run against the real store.
 *
 * Mock coverage note (per writing-tests SKILL.md): dispatchOversight is mocked
 * to the allow outcome only. Untested branches: oversight deny / pending /
 * dispatch-failure pauses — not part of the #2502 unit list pinned here.
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
	PR_FEEDBACK_LOOP_STATE_REL,
} from '../../../src/background/pr-feedback-loop.js';
import {
	buildCorrelationId,
	subscribe,
	updateSnapshot,
} from '../../../src/background/pr-subscriptions.js';
import { PrFeedbackLoopConfigSchema } from '../../../src/config/schema.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { _test_exports as gateInternals } from '../../../src/hooks/pr-workflow-gate.js';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir';

const SESSION = 'sess-loop';
const REPO = 'example/repo';
const PR = 42;
const PR_URL = 'https://github.com/example/repo/pull/42';
const HEAD = 'h1';
const CORRELATION = buildCorrelationId(SESSION, REPO, PR);
/** Fixed clock base for circuit tests (static — no Date.now arithmetic). */
const T0 = 1_757_000_000_000;

const ENABLED_CONFIG = {
	pr_monitor: { enabled: true, auto_pr_feedback: true },
	pr_feedback_loop: { enabled: true },
};

// Captured at module top; restored into the seam in afterEach.
const loopInternalsOriginals = { ...loopInternals };
const savedXdg = process.env.XDG_CONFIG_HOME;
let xdgIsolationDir = '';
const createdDirs: string[] = [];

interface LoopStateFile {
	correlations?: Record<
		string,
		{
			prActionsUsed?: number;
			circuit?: { failures?: number; openUntil?: number };
			terminal?: { state?: string; reason?: string } | null;
		}
	>;
}

beforeAll(() => {
	xdgIsolationDir = canonicalMkdtemp('issue-2502-loop-xdg-');
	process.env.XDG_CONFIG_HOME = xdgIsolationDir;
});

afterAll(() => {
	if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = savedXdg;
	if (xdgIsolationDir) {
		fs.rmSync(xdgIsolationDir, { recursive: true, force: true });
	}
});

beforeEach(() => {
	queueInternals.resetQueueCache();
	gateInternals.resetTrackedStateCache();
});

afterEach(() => {
	Object.assign(loopInternals, loopInternalsOriginals);
	queueInternals.resetQueueCache();
	gateInternals.resetTrackedStateCache();
	closeAllProjectDbs();
	for (const dir of createdDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function makeProject(
	config: Record<string, unknown> | null = ENABLED_CONFIG,
): string {
	const dir = canonicalMkdtemp('issue-2502-loop-');
	createdDirs.push(dir);
	if (config) {
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(config, null, 2),
			'utf-8',
		);
	}
	return dir;
}

async function primeSubscription(dir: string): Promise<void> {
	await subscribe(dir, {
		sessionID: SESSION,
		prNumber: PR,
		repoFullName: REPO,
		prUrl: PR_URL,
	});
	await updateSnapshot(dir, CORRELATION, { headRefOid: HEAD });
}

interface EventOverrides {
	type?: string;
	repoFullName?: string;
	prNumber?: number;
	prUrl?: string;
	message?: string;
	dedupToken?: string;
}

async function enqueueEvent(
	dir: string,
	overrides: EventOverrides = {},
): Promise<void> {
	await enqueuePrFeedbackMonitorEvent(dir, SESSION, {
		type: 'pr.ci.failed',
		repoFullName: REPO,
		prNumber: PR,
		prUrl: PR_URL,
		message: 'ci check failed',
		dedupToken: 'tok-1',
		authorized: true,
		queuedAt: '2026-09-01T00:00:00.000Z',
		...overrides,
	});
}

/** Install the happy-path seams; returns the performer mock for call counts. */
function installLoopSeams(
	opts: { head?: string | null; performer?: () => Promise<unknown> } = {},
): ReturnType<typeof mock> {
	loopInternals.evaluateCurrentHead = mock(async () =>
		opts.head === undefined ? HEAD : opts.head,
	) as unknown as typeof loopInternals.evaluateCurrentHead;
	loopInternals.dispatchOversight = mock(async () => ({
		dispatched: true,
		decision: 'allow',
	})) as unknown as typeof loopInternals.dispatchOversight;
	const performer = mock(opts.performer ?? (async () => ({ performed: true })));
	loopInternals.performAuthorizedAction =
		performer as unknown as typeof loopInternals.performAuthorizedAction;
	return performer;
}

function readLoopStateFile(dir: string): LoopStateFile {
	return JSON.parse(
		fs.readFileSync(path.join(dir, PR_FEEDBACK_LOOP_STATE_REL), 'utf-8'),
	) as LoopStateFile;
}

describe('issue #2502 PrFeedbackLoopConfigSchema', () => {
	test('defaults to disabled, bounded budgets, publication none', () => {
		expect(PrFeedbackLoopConfigSchema.parse({})).toEqual({
			enabled: false,
			max_actions_per_pr: 3,
			max_session_actions: 10,
			publication: 'none',
		});
	});

	test('rejects a non-none publication mode (single-value enum)', () => {
		expect(() =>
			PrFeedbackLoopConfigSchema.parse({ publication: 'push' }),
		).toThrow();
	});
});

describe('issue #2502 pr-feedback-loop settle pipeline', () => {
	test('disabled without a config file: no-op with authorization disabled', async () => {
		const dir = makeProject(null);
		await primeSubscription(dir);
		const performer = installLoopSeams();
		await enqueueEvent(dir);

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.ran).toBe(false);
		expect(result.reason).toMatch(/disabled/);
		expect(result.authorization?.authorized).toBe(false);
		expect(result.authorization?.reason).toMatch(/disabled/);
		expect(performer).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(dir, PR_FEEDBACK_LOOP_STATE_REL))).toBe(
			false,
		);
	});

	test('enabled with an empty queue: queue-empty no-op', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		installLoopSeams();

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.ran).toBe(false);
		expect(result.reason).toBe('queue-empty');
		expect(result.terminal).toBeNull();
	});

	test('full settle: authorized action performed + recorded + single wake', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const performer = installLoopSeams();
		await enqueueEvent(dir);

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.ran).toBe(true);
		expect(result.authorization?.authorized).toBe(true);
		expect(result.action).toMatchObject({ kind: 'fix_ci', performed: true });
		expect(performer).toHaveBeenCalledTimes(1);
		expect(result.terminal?.state).toBe('completed');
		// M4 scope pin: the terminal reason always states the completion scope.
		expect(result.terminal?.reason).toMatch(
			/performed.*recorded.*accepted.*prompt\/advisory/i,
		);
		const state = readLoopStateFile(dir);
		expect(state.correlations?.[CORRELATION]?.terminal?.state).toBe(
			'completed',
		);
		expect(result.authorization?.budget?.prActionsUsed).toBe(1);
	});

	test('idempotency: re-enqueued dedup token replays without re-performing', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const performer = installLoopSeams();
		await enqueueEvent(dir, { dedupToken: 'tok-1' });
		const first = await claimAndProcessPrFeedbackEvent(dir, SESSION);
		expect(first.terminal?.state).toBe('completed');

		await enqueueEvent(dir, { dedupToken: 'tok-1' });
		const replay = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(replay.authorization?.replay).toBe(true);
		expect(replay.authorization?.authorized).toBe(false);
		expect(performer).toHaveBeenCalledTimes(1);
		expect(replay.terminal).toEqual(first.terminal);
	});

	test('stale head: event head must match the freshly evaluated head', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const performer = installLoopSeams({ head: 'h2' }); // subscription says 'h1'
		await enqueueEvent(dir);

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.authorization?.authorized).toBe(false);
		expect(result.authorization?.stale).toBe(false);
		expect(result.authorization?.reason).toMatch(
			/snapshot synchronization|retryable/,
		);
		expect(result.action?.performed).toBe(false);
		expect(result.terminal).toBeNull();
		expect(performer).not.toHaveBeenCalled();
		expect(
			(await readPrFeedbackMonitorQueue(dir, SESSION))?.events[0]
				?.claimedWorkflowInstanceId,
		).toBeUndefined();
	});

	test('foreign event: no matching subscription correlation is refused', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const performer = installLoopSeams();
		await enqueueEvent(dir, {
			repoFullName: 'other/repo',
			prNumber: 7,
			prUrl: 'https://github.com/other/repo/pull/7',
			dedupToken: 'tok-foreign',
		});

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.authorization?.authorized).toBe(false);
		expect(result.authorization?.foreign).toBe(true);
		expect(result.authorization?.reason).toMatch(/foreign/);
		expect(result.action?.performed).toBe(false);
		expect(performer).not.toHaveBeenCalled();
	});

	test('unsupported event type: refused terminal, no action', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const performer = installLoopSeams();
		await enqueueEvent(dir, { type: 'pr.merged', dedupToken: 'tok-merged' });

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.classification?.supported).toBe(false);
		expect(result.classification?.reason).toMatch(/unsupported/);
		expect(result.action?.performed).toBe(false);
		expect(result.terminal?.state).toBe('refused');
		expect(performer).not.toHaveBeenCalled();
	});

	test('ambiguous head evaluation: remains pending, no write-class action', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const performer = installLoopSeams({ head: null });
		await enqueueEvent(dir);

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.classification?.ambiguous).toBe(true);
		expect(result.authorization?.authorized).toBe(false);
		expect(result.authorization?.reason).toMatch(/ambiguous/);
		expect(result.action?.performed).toBe(false);
		expect(result.terminal).toBeNull();
		expect(performer).not.toHaveBeenCalled();
		expect(
			(await readPrFeedbackMonitorQueue(dir, SESSION))?.events[0]
				?.claimedWorkflowInstanceId,
		).toBeUndefined();
	});

	test('cancellation refuses corrupt state without overwriting the queue', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		await enqueueEvent(dir);
		loopInternals.readState = mock(async () => ({
			corrupt: true,
		})) as unknown as typeof loopInternals.readState;

		const result = await cancelPrFeedbackLoop(dir, SESSION, 'operator stop');

		expect(result.terminalState).toBe('paused_for_human');
		expect(result.reason).toMatch(/could not be durably recorded/);
		expect(
			(await readPrFeedbackMonitorQueue(dir, SESSION))?.events[0]?.dedupToken,
		).toBe('tok-1');
	});

	test('budget: max_actions_per_pr 1 pauses the second event for a human', async () => {
		const dir = makeProject({
			pr_monitor: { enabled: true, auto_pr_feedback: true },
			pr_feedback_loop: { enabled: true, max_actions_per_pr: 1 },
		});
		await primeSubscription(dir);
		const performer = installLoopSeams();
		await enqueueEvent(dir, { dedupToken: 'tok-1' });
		const first = await claimAndProcessPrFeedbackEvent(dir, SESSION);
		expect(first.terminal?.state).toBe('completed');

		// Different action class (pr.merge.conflict) -> a distinct digest, so
		// this is a NEW event, not a replay of tok-1.
		await enqueueEvent(dir, {
			type: 'pr.merge.conflict',
			dedupToken: 'tok-2',
		});
		const second = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(second.terminal?.state).toBe('paused_for_human');
		expect(second.terminal?.reason).toMatch(/budget/);
		expect(second.authorization?.budget?.exhausted).toBe(true);
		expect(performer).toHaveBeenCalledTimes(1);
	});

	test('transient performer failure: degraded terminal + future circuit openUntil', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		loopInternals.now = () => T0;
		const flaky = installLoopSeams({
			performer: async () => {
				throw new Error('HTTP 503 Service Unavailable');
			},
		});
		await enqueueEvent(dir);

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.terminal?.state).toBe('degraded');
		expect(result.terminal?.reason).toMatch(/circuit open/i);
		// 1 initial attempt + 2 bounded transient retries.
		expect(flaky).toHaveBeenCalledTimes(3);
		const circuit = readLoopStateFile(dir).correlations?.[CORRELATION]?.circuit;
		expect(circuit?.openUntil ?? 0).toBeGreaterThan(T0);
	});

	test('permanent performer failure: paused_for_human, exactly one attempt', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const permanent = installLoopSeams({
			performer: async () => {
				throw new Error('ReferenceError: x is not defined');
			},
		});
		await enqueueEvent(dir);

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(result.terminal?.state).toBe('paused_for_human');
		expect(result.terminal?.reason).toMatch(/permanent action failure/);
		expect(result.action?.performed).toBe(false);
		expect(permanent).toHaveBeenCalledTimes(1);
	});

	test('half-open probe: post-cooldown event is admitted and closes the circuit', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		loopInternals.now = () => T0;
		installLoopSeams({
			performer: async () => {
				throw new Error('HTTP 503 Service Unavailable');
			},
		});
		await enqueueEvent(dir, { dedupToken: 'tok-1' });
		const degraded = await claimAndProcessPrFeedbackEvent(dir, SESSION);
		expect(degraded.terminal?.state).toBe('degraded');

		// Advance the injected clock past openUntil (+ cooldown margin).
		loopInternals.now = () => T0 + 60_000 + 1_000;
		const performer = installLoopSeams();
		await enqueueEvent(dir, {
			type: 'pr.merge.conflict',
			dedupToken: 'tok-2',
		});
		const recovered = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(performer).toHaveBeenCalledTimes(1);
		expect(recovered.terminal?.state).toBe('completed');
		const circuit = readLoopStateFile(dir).correlations?.[CORRELATION]?.circuit;
		expect(circuit?.openUntil).toBe(0);
	});

	test('restoration: stripped terminal is re-recorded without re-performing', async () => {
		const dir = makeProject();
		await primeSubscription(dir);
		const performer = installLoopSeams();
		await enqueueEvent(dir, { dedupToken: 'tok-1' });
		const first = await claimAndProcessPrFeedbackEvent(dir, SESSION);
		expect(first.terminal?.state).toBe('completed');

		// Simulate an interrupted settlement: digest persisted, terminal lost.
		const statePath = path.join(dir, PR_FEEDBACK_LOOP_STATE_REL);
		const raw = readLoopStateFile(dir) as Record<string, unknown> &
			LoopStateFile;
		const correlation = raw.correlations?.[CORRELATION] as Record<
			string,
			unknown
		>;
		delete correlation.terminal;
		delete correlation.inFlight;
		fs.writeFileSync(statePath, JSON.stringify(raw, null, 2), 'utf-8');

		await enqueueEvent(dir, { dedupToken: 'tok-1' });
		const restored = await claimAndProcessPrFeedbackEvent(dir, SESSION);

		expect(restored.terminal?.state).toBe('completed');
		expect(restored.terminal?.reason).toMatch(/restored after interruption/i);
		expect(restored.authorization?.replay).toBe(true);
		expect(performer).toHaveBeenCalledTimes(1);
	});
});
