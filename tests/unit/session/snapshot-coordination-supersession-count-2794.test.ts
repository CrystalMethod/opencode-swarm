/**
 * Issue #2794 — bounded, counts-only `plan_recovery_superseded` telemetry for
 * coordination-initialization supersession (F-004 follow-up on #2777/#2668).
 * Covers increment on both settlement paths, no-emit-on-success (and the
 * success-inflation probe), cumulative counting (RELATIVE assertions only —
 * the counter is module state shared across test files in one bun process),
 * closing-guard exclusion incl. the timeout-overwrite window, and the
 * counts-only payload key allowlist. Manufacture patterns/hygiene mirror
 * tests/unit/session/restart-coordination-supersession-2668.test.ts; telemetry
 * wiring: initTelemetry on the fixture project (emit() fans out only after the
 * stream exists); resetTelemetryForTesting() in afterEach before removal.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	PlanRecoverySupersededError,
	resetStartupLedgerCheck,
} from '../../../src/plan/manager';
import { beginHydrationScope } from '../../../src/session/hydration-ownership';
import {
	_snapshotCoordinationInternals,
	beginSnapshotCoordinationReset,
	getSnapshotCoordinationStatus,
	startSnapshotCoordinationInitialization,
} from '../../../src/session/snapshot-coordination-init';
import { writeSnapshotRows } from '../../../src/session/snapshot-store';
import {
	type SnapshotData,
	writeSnapshotProjection,
} from '../../../src/session/snapshot-writer';
import { resetSwarmState } from '../../../src/state';
import {
	addTelemetryListener,
	initTelemetry,
	removeTelemetryListener,
	resetTelemetryForTesting,
	type TelemetryListener,
} from '../../../src/telemetry';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { withFrozenClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const EVENT_KIND = 'plan_recovery_superseded';
const originalLoadPlan = _snapshotCoordinationInternals.loadPlan;
const originalReadSnapshotFileStrict =
	_snapshotCoordinationInternals.readSnapshotFileStrict;
const originalInitialize = _snapshotCoordinationInternals.initialize;
const temporaryDirectories: string[] = [];
const captured: Array<Record<string, unknown>> = [];
let activeListener: TelemetryListener | null = null;

function makeSnapshot(marker: string): SnapshotData {
	return {
		version: 3,
		writtenAt: withFrozenClock(() => Date.now()),
		toolAggregates: { [marker]: { count: 1 } },
		activeAgent: {},
		delegationChains: {},
		agentSessions: {},
	} as unknown as SnapshotData;
}

function makeProject(label: string): string {
	const directory = canonicalMkdtemp(`swarm-2794-count-${label}-`);
	mkdirSync(path.join(directory, '.git'));
	temporaryDirectories.push(directory);
	return directory;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error('timed out waiting for coordination boundary');
}

function installListener(): void {
	captured.length = 0;
	const listener: TelemetryListener = (event, data) => {
		if ((event as string) === EVENT_KIND) captured.push(data);
	};
	activeListener = listener;
	addTelemetryListener(listener);
}

/**
 * Manufacture pattern A wrapper: the wrapper's FIRST invocation begins a
 * newer hydration generation, so the coordinator's real preCommitCheck fence
 * rejects the attempt with the typed error. Reinstall for each attempt that
 * must be superseded.
 */
function installBumpingLoadPlan(): void {
	let loadPlanCalls = 0;
	_snapshotCoordinationInternals.loadPlan = async (root, cache, options) => {
		loadPlanCalls += 1;
		if (loadPlanCalls === 1) beginHydrationScope(root);
		return originalLoadPlan(root, cache, options);
	};
}

async function supersedeViaTypedError(directory: string): Promise<void> {
	await writeApprovedPlan(directory, [
		{ id: '1.1', files: ['src/probe.ts'], status: 'completed' },
	]);
	installBumpingLoadPlan();
	await expect(
		startSnapshotCoordinationInitialization(directory),
	).rejects.toBeInstanceOf(PlanRecoverySupersededError);
}

async function succeedInitialization(directory: string): Promise<void> {
	writeSnapshotRows(directory, makeSnapshot(`${directory}-success`));
	await writeSnapshotProjection(
		directory,
		makeSnapshot(`${directory}-success-projection`),
	);
	await expect(
		startSnapshotCoordinationInitialization(directory),
	).resolves.toBeUndefined();
	expect(getSnapshotCoordinationStatus(directory)).toMatchObject({
		state: 'succeeded',
		settled: true,
	});
}

beforeEach(() => {
	_snapshotCoordinationInternals.entries.clear();
	_snapshotCoordinationInternals.loadPlan = originalLoadPlan;
	_snapshotCoordinationInternals.readSnapshotFileStrict =
		originalReadSnapshotFileStrict;
	_snapshotCoordinationInternals.initialize = originalInitialize;
	resetStartupLedgerCheck();
	resetSwarmState();
	captured.length = 0;
});

afterEach(() => {
	if (activeListener !== null) {
		removeTelemetryListener(activeListener);
		activeListener = null;
	}
	resetTelemetryForTesting();
	_snapshotCoordinationInternals.entries.clear();
	_snapshotCoordinationInternals.loadPlan = originalLoadPlan;
	_snapshotCoordinationInternals.readSnapshotFileStrict =
		originalReadSnapshotFileStrict;
	_snapshotCoordinationInternals.initialize = originalInitialize;
	resetStartupLedgerCheck();
	resetSwarmState();
	closeAllProjectDbs();
	for (const directory of temporaryDirectories.splice(0)) {
		safeRmRecursive(directory);
	}
});

describe('issue #2794 — bounded supersession counts', () => {
	test('typed plan-recovery supersession emits one countable event', async () => {
		const directory = makeProject('a-plan-recovery');
		initTelemetry(directory);
		installListener();
		await supersedeViaTypedError(directory);

		expect(getSnapshotCoordinationStatus(directory)).toMatchObject({
			state: 'superseded',
			settled: true,
		});
		expect(captured.length).toBe(1);
		const payload = captured[0]!;
		expect(Object.keys(payload).sort()).toEqual(['count', 'trigger']);
		expect(payload.trigger).toBe('plan_recovery');
		expect(typeof payload.count).toBe('number');
	});

	test('coordination-fence supersession emits one countable event', async () => {
		const directory = makeProject('b-fence');
		initTelemetry(directory);
		installListener();
		// Manufacture pattern B: hold the strict read at its async boundary,
		// begin a newer hydration generation, release. The attempt RESOLVES with
		// the 'superseded' outcome.
		await writeSnapshotProjection(directory, makeSnapshot('fence'));
		let releaseRead!: () => void;
		let strictReadStarted = false;
		const readBarrier = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		_snapshotCoordinationInternals.readSnapshotFileStrict = async (
			root,
			relativePath,
		) => {
			strictReadStarted = true;
			await readBarrier;
			return originalReadSnapshotFileStrict(root, relativePath);
		};

		const initialization = startSnapshotCoordinationInitialization(directory);
		await waitFor(() => strictReadStarted);
		beginHydrationScope(directory);
		releaseRead();
		await initialization;

		expect(getSnapshotCoordinationStatus(directory)).toMatchObject({
			state: 'superseded',
			settled: true,
		});
		expect(captured.length).toBe(1);
		const payload = captured[0]!;
		expect(Object.keys(payload).sort()).toEqual(['count', 'trigger']);
		expect(payload.trigger).toBe('coordination_fence');
		expect(typeof payload.count).toBe('number');
	});

	test('successful initialization emits no supersession event', async () => {
		const directory = makeProject('c-success');
		initTelemetry(directory);
		installListener();
		await succeedInitialization(directory);
		expect(captured.length).toBe(0);
	});

	test('count is cumulative across attempts', async () => {
		const directory = makeProject('d-cumulative');
		initTelemetry(directory);
		installListener();
		await supersedeViaTypedError(directory);
		await supersedeViaTypedError(directory);

		expect(captured.length).toBe(2);
		const first = captured[0]! as { count?: unknown };
		const second = captured[1]! as { count?: unknown };
		expect(typeof first.count).toBe('number');
		expect(typeof second.count).toBe('number');
		// RELATIVE assertion only: the count is process-local cumulative, so the
		// second event's count must be exactly one past the first event's.
		expect(second.count).toBe((first.count as number) + 1);
	});

	test('a successful attempt between supersessions contributes nothing', async () => {
		// Distinct roots: a settled 'succeeded' entry coalesces later
		// same-root starts (no fresh attempt would run), so the interleaved
		// success uses its own root while the counter stays module-global.
		const first = makeProject('f-inflate-a');
		const middle = makeProject('f-inflate-b');
		const last = makeProject('f-inflate-c');
		initTelemetry(first);
		installListener();

		await supersedeViaTypedError(first);
		await succeedInitialization(middle);
		await supersedeViaTypedError(last);

		// Exactly one event per supersession; the success contributed none —
		// this pins both the increment-without-emit and emit-on-success defects.
		expect(captured.length).toBe(2);
		const firstPayload = captured[0]! as { count: number };
		const lastPayload = captured[1]! as { count: number };
		expect(firstPayload.trigger).toBe('plan_recovery');
		expect(lastPayload.trigger).toBe('plan_recovery');
		expect(lastPayload.count).toBe(firstPayload.count + 1);
	});

	test('entry replaced after timeout does not count (typed path, reset awaited)', async () => {
		const directory = makeProject('e-closing-typed');
		initTelemetry(directory);
		installListener();
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/closing.ts'], status: 'completed' },
		]);

		// Hold the attempt inside loadPlan while a deliberate reset runs to
		// completion; by settle time the attempt's own timeout has fired and
		// the reset has replaced the attempt's map entry with its guard, so
		// the typed supersession must NOT be counted. This pins the identity
		// half of the .catch guard; the closing half alone is pinned by the
		// timeout-overwrite-window tests below.
		const originalTimeoutMs = _snapshotCoordinationInternals.timeoutMs;
		_snapshotCoordinationInternals.timeoutMs = 250;
		let releasePlan!: () => void;
		let loadPlanStarted = false;
		const planBarrier = new Promise<void>((resolve) => {
			releasePlan = resolve;
		});
		_snapshotCoordinationInternals.loadPlan = async (root, cache, options) => {
			loadPlanStarted = true;
			await planBarrier;
			// Bump the generation only after the reset has run so the rejection
			// is the typed plan-recovery supersession settling after the reset.
			beginHydrationScope(root);
			return originalLoadPlan(root, cache, options);
		};

		try {
			const initialization = startSnapshotCoordinationInitialization(directory);
			await waitFor(() => loadPlanStarted);
			// The reset waits for the held attempt and times out (bounded); the
			// attempt's own side-chain timer fires first, then the reset
			// installs its 'closing' guard entry over the attempt's slot.
			const guard = await beginSnapshotCoordinationReset(directory);
			expect(guard.priorUnsettled).toBe(true);

			releasePlan();
			await expect(initialization).rejects.toBeInstanceOf(
				PlanRecoverySupersededError,
			);
			expect(getSnapshotCoordinationStatus(directory)).toMatchObject({
				state: 'closing',
				settled: true,
			});
			guard.release();
			expect(captured.length).toBe(0);
		} finally {
			_snapshotCoordinationInternals.timeoutMs = originalTimeoutMs;
		}
	});

	test('closing-guard settlement does not count (fence outcome path)', async () => {
		const directory = makeProject('e-closing-fence');
		initTelemetry(directory);
		installListener();
		await writeSnapshotProjection(directory, makeSnapshot('closing-fence'));

		// Capture the raw initialize outcome so the test fails loudly if the
		// manufacture degrades to the success path (the .then guard never
		// writes entry.state = 'superseded' under closing, so status alone
		// cannot prove the fence branch ran).
		let observedOutcome: string | undefined;
		_snapshotCoordinationInternals.initialize = async (root, scope) => {
			const outcome = await originalInitialize(root, scope);
			observedOutcome = outcome;
			return outcome;
		};

		let releaseRead!: () => void;
		let strictReadStarted = false;
		const readBarrier = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		_snapshotCoordinationInternals.readSnapshotFileStrict = async (
			root,
			relativePath,
		) => {
			strictReadStarted = true;
			await readBarrier;
			return originalReadSnapshotFileStrict(root, relativePath);
		};

		const initialization = startSnapshotCoordinationInitialization(directory);
		await waitFor(() => strictReadStarted);
		// beginSnapshotCoordinationReset sets prior.state = 'closing' before its
		// first await; then the generation bump (pattern B's defining step) makes
		// the held attempt resolve with the 'superseded' OUTCOME under closing.
		const resetPromise = beginSnapshotCoordinationReset(directory);
		beginHydrationScope(directory);
		releaseRead();
		await initialization;
		const guard = await resetPromise;

		expect(observedOutcome).toBe('superseded');
		guard.release();
		expect(captured.length).toBe(0);
	});

	test('deliberate reset in the timeout-overwrite window does not count (typed path)', async () => {
		// Pins the .catch guard's closing half ALONE: release the barrier in the
		// window AFTER the attempt's side-chain timer has fired (400ms) but
		// BEFORE the reset's own timer (started 250ms later, fires at 650ms), so
		// the reset's guard entry is NOT installed yet and the entry is still
		// mapped at settle time. The side-chain must preserve 'closing' (it
		// must not overwrite it with 'timed_out'), making the closing half of
		// the emit guard the only defense in this interleaving.
		const directory = makeProject('e-window-typed');
		initTelemetry(directory);
		installListener();
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/window.ts'], status: 'completed' },
		]);

		const originalTimeoutMs = _snapshotCoordinationInternals.timeoutMs;
		_snapshotCoordinationInternals.timeoutMs = 400;
		let releasePlan!: () => void;
		let loadPlanStarted = false;
		const planBarrier = new Promise<void>((resolve) => {
			releasePlan = resolve;
		});
		_snapshotCoordinationInternals.loadPlan = async (root, cache, options) => {
			loadPlanStarted = true;
			await planBarrier;
			beginHydrationScope(root);
			return originalLoadPlan(root, cache, options);
		};

		try {
			const initialization = startSnapshotCoordinationInitialization(directory);
			await waitFor(() => loadPlanStarted);
			// Stagger the reset 250ms behind the attempt so its timeout lands
			// ~250ms after the attempt's — that gap is the release window.
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
			const resetPromise = beginSnapshotCoordinationReset(directory);
			// Release past the attempt's timer (~400ms) and before the reset's
			// (~650ms): settle while the entry is still mapped and 'closing'
			// (with the side-chain closing check) or 'timed_out' (without it —
			// the mutation this test pins).
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
			releasePlan();
			await expect(initialization).rejects.toBeInstanceOf(
				PlanRecoverySupersededError,
			);
			const guard = await resetPromise;
			guard.release();
			expect(captured.length).toBe(0);
		} finally {
			_snapshotCoordinationInternals.timeoutMs = originalTimeoutMs;
		}
	});

	test('deliberate reset in the timeout-overwrite window does not count (fence outcome path)', async () => {
		// Same window as the typed variant, settled through the .then
		// 'superseded'-outcome branch: the early return must fire on the
		// closing state the side-chain preserved.
		const directory = makeProject('e-window-fence');
		initTelemetry(directory);
		installListener();
		await writeSnapshotProjection(directory, makeSnapshot('window-fence'));

		let observedOutcome: string | undefined;
		_snapshotCoordinationInternals.initialize = async (root, scope) => {
			const outcome = await originalInitialize(root, scope);
			observedOutcome = outcome;
			return outcome;
		};

		const originalTimeoutMs = _snapshotCoordinationInternals.timeoutMs;
		_snapshotCoordinationInternals.timeoutMs = 400;
		let releaseRead!: () => void;
		let strictReadStarted = false;
		const readBarrier = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		_snapshotCoordinationInternals.readSnapshotFileStrict = async (
			root,
			relativePath,
		) => {
			strictReadStarted = true;
			await readBarrier;
			return originalReadSnapshotFileStrict(root, relativePath);
		};

		try {
			const initialization = startSnapshotCoordinationInitialization(directory);
			await waitFor(() => strictReadStarted);
			// Stagger the reset 250ms behind the attempt (same window geometry
			// as the typed variant).
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
			const resetPromise = beginSnapshotCoordinationReset(directory);
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
			// Pattern B's generation bump, released inside the window so the
			// attempt resolves with the 'superseded' OUTCOME while the entry is
			// still mapped.
			beginHydrationScope(directory);
			releaseRead();
			await initialization;
			expect(observedOutcome).toBe('superseded');
			const guard = await resetPromise;
			guard.release();
			expect(captured.length).toBe(0);
		} finally {
			_snapshotCoordinationInternals.timeoutMs = originalTimeoutMs;
			_snapshotCoordinationInternals.initialize = originalInitialize;
		}
	});

	test('plain failure settles failed without counting', async () => {
		// Negative path: a non-typed error from the attempt (one that escapes
		// initializeSnapshotCoordination — loadPlan-internal plain errors are
		// advisory-caught, but a strict-read throw is not) must settle the
		// entry 'failed' and emit NOTHING (a regression that calls
		// recordSupersession unconditionally in the .catch would fail here).
		const directory = makeProject('g-plain-failure');
		initTelemetry(directory);
		installListener();
		await writeSnapshotProjection(directory, makeSnapshot('plain-failure'));
		_snapshotCoordinationInternals.readSnapshotFileStrict = async () => {
			throw new Error('boom: plain coordination failure');
		};

		await expect(
			startSnapshotCoordinationInitialization(directory),
		).rejects.toThrow('boom: plain coordination failure');
		expect(getSnapshotCoordinationStatus(directory)).toMatchObject({
			state: 'failed',
			settled: true,
		});
		expect(captured.length).toBe(0);
	});
});
