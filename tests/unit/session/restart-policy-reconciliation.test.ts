/**
 * Restart-boundary tests for durable QA policy + owner-named reconciliation
 * (issue #2668).
 *
 * Pins the two contracts the rehydrate boundary now carries:
 * 1. A ratchet-tighter session override (written durable-first by the
 *    /swarm qa-gates override command) survives the boundary; a NEW session
 *    still starts with no override.
 * 2. An execution interrupted mid-flight (serialized delegationActive=true)
 *    reconciles to a bounded, owner-named outcome: durable artifact +
 *    one-shot advisory, deduped across repeated restarts, while the ephemeral
 *    authority itself expires.
 * 3. Session teardown (end + stale sweep) deletes the durable override row in
 *    lockstep with the in-memory session.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { handleQaGatesCommand } from '../../../src/commands/qa-gates.js';
import {
	getOverrideForSession,
	setOverrideForSession,
} from '../../../src/db/qa-gate-session-override.js';
import { beginHydrationScope } from '../../../src/session/hydration-ownership.js';
import {
	RESTART_RECONCILIATION_FILE,
	readRestartReconciliation,
	recordInterruptedExecution,
} from '../../../src/session/restart-reconciliation.js';
import { rehydrateState } from '../../../src/session/snapshot-reader.js';
import {
	type SnapshotData,
	serializeAgentSession,
} from '../../../src/session/snapshot-writer.js';
import {
	endAgentSession,
	getAgentSession,
	resetSwarmStatePreservingSingletons,
	swarmState,
	sweepStaleSessions,
} from '../../../src/state.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION = 'sess-2668-unit';
const TASK = '1.1';

let project: string;
let restoreClock: () => void = () => {};

function writeMinimalPlanJson(directory: string): void {
	const plan = {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [
					{
						id: TASK,
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Task 1',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
	const swarmDir = path.join(directory, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf8',
	);
}

function bootSessionWithInFlightExecution(inFlight = true): SnapshotData {
	writeMinimalPlanJson(project);
	resetSwarmStatePreservingSingletons();
	const { startAgentSession } = require('../../../src/state.js') as {
		startAgentSession: (
			id: string,
			agent: string,
			ttl: number,
			dir: string,
		) => void;
	};
	startAgentSession(SESSION, 'architect', 7_200_000, project);
	const session = getAgentSession(SESSION);
	if (!session) throw new Error('session missing');
	session.delegationActive = inFlight;
	session.currentTaskId = TASK;
	return {
		version: 3,
		writtenAt: Date.now(),
		toolAggregates: {},
		activeAgent: { [SESSION]: 'architect' },
		delegationChains: {},
		agentSessions: { [SESSION]: serializeAgentSession(session) },
	};
}

async function crossBoundary(
	snapshot: SnapshotData,
): Promise<ReturnType<typeof getAgentSession>> {
	resetSwarmStatePreservingSingletons();
	const scope = beginHydrationScope(project);
	const outcome = await rehydrateState(snapshot, project, scope);
	expect(outcome.applied).toBe(true);
	return getAgentSession(SESSION);
}

beforeEach(() => {
	project = canonicalMkdtemp('swarm-2668-unit-');
	// Whole-file freeze (check:test-clock): fixedNow is captured from the real
	// clock BEFORE the freeze so the stale-eviction arithmetic below keeps its
	// relative semantics while every read inside the test is deterministic.
	restoreClock = freezeClock({ fixedNow: Date.now() });
});

afterEach(() => {
	restoreClock();
	resetSwarmStatePreservingSingletons();
	try {
		rmSync(project, { recursive: true, force: true, maxRetries: 3 });
	} catch {
		// best-effort
	}
});

describe('durable tightened QA policy across the restart boundary (#2668)', () => {
	test('command-written override survives rehydrate; effective gates stay tightened', async () => {
		writeMinimalPlanJson(project);
		resetSwarmStatePreservingSingletons();
		const { startAgentSession } = require('../../../src/state.js') as {
			startAgentSession: (
				id: string,
				agent: string,
				ttl: number,
				dir: string,
			) => void;
		};
		startAgentSession(SESSION, 'architect', 7_200_000, project);
		const out = await handleQaGatesCommand(
			project,
			['override', 'mutation_test'],
			SESSION,
		);
		expect(out).toContain('Session overrides updated');
		expect(out).toContain('durable across restart');
		const snapshot: SnapshotData = {
			version: 3,
			writtenAt: Date.now(),
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {
				[SESSION]: serializeAgentSession(getAgentSession(SESSION)!),
			},
		};
		const restored = await crossBoundary(snapshot);
		expect(restored?.qaGateSessionOverrides?.mutation_test).toBe(true);
		expect(getOverrideForSession(project, SESSION)).toEqual({
			mutation_test: true,
		});
	});

	test('a NEW session starts with no override (only existing sessions preserve)', async () => {
		setOverrideForSession(project, 'some-other-session', {
			mutation_test: true,
		});
		resetSwarmStatePreservingSingletons();
		const { startAgentSession } = require('../../../src/state.js') as {
			startAgentSession: (
				id: string,
				agent: string,
				ttl: number,
				dir: string,
			) => void;
		};
		startAgentSession('fresh-session', 'architect', 7_200_000, project);
		expect(
			getAgentSession('fresh-session')?.qaGateSessionOverrides ?? {},
		).toEqual({});
	});

	test('override restore fails open when the project DB is unreadable', async () => {
		const snapshot = bootSessionWithInFlightExecution();
		setOverrideForSession(project, SESSION, { mutation_test: true });
		// Corrupt the durable authority without touching the snapshot: make
		// swarm.db a directory so getProjectDb cannot open it. The boundary
		// must still apply the snapshot (fail-open), just without the override.
		rmSync(path.join(project, '.swarm', 'swarm.db'), { force: true });
		mkdirSync(path.join(project, '.swarm', 'swarm.db'), { recursive: true });
		resetSwarmStatePreservingSingletons();
		const scope = beginHydrationScope(project);
		const outcome = await rehydrateState(snapshot, project, scope);
		expect(outcome.applied).toBe(true);
		expect(getAgentSession(SESSION)?.agentName).toBe('architect');
		rmSync(path.join(project, '.swarm', 'swarm.db'), {
			recursive: true,
			force: true,
		});
	});

	test('back-to-back double restart keeps the durable row and restores both times (R8)', async () => {
		setOverrideForSession(project, SESSION, { mutation_test: true });
		const snapshot = bootSessionWithInFlightExecution();
		const first = await crossBoundary(snapshot);
		expect(first?.qaGateSessionOverrides?.mutation_test).toBe(true);
		const snapshot2: SnapshotData = {
			version: 3,
			writtenAt: Date.now(),
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: { [SESSION]: serializeAgentSession(first!) },
		};
		const second = await crossBoundary(snapshot2);
		expect(second?.qaGateSessionOverrides?.mutation_test).toBe(true);
		expect(getOverrideForSession(project, SESSION)).toEqual({
			mutation_test: true,
		});
	});
});

describe('owner-named reconciliation for interrupted executions (#2668)', () => {
	test('records owner + task + unknown classification; advisory survives transient reset', async () => {
		const snapshot = bootSessionWithInFlightExecution();
		const restored = await crossBoundary(snapshot);
		// Ephemeral authority expired...
		expect(restored?.delegationActive).toBe(false);
		// ...but the expiry is recorded, not silent.
		const artifactPath = path.join(
			project,
			'.swarm',
			RESTART_RECONCILIATION_FILE,
		);
		expect(existsSync(artifactPath)).toBe(true);
		const file = readRestartReconciliation(project);
		expect(file.entries).toHaveLength(1);
		expect(file.entries[0]).toMatchObject({
			sessionId: SESSION,
			agentName: 'architect',
			taskId: TASK,
			classification: 'interrupted',
		});
		expect(file.entries[0].guidance).toContain('/swarm recover');
		const advisory = restored?.pendingAdvisoryMessages?.join(' ') ?? '';
		expect(advisory).toContain(SESSION);
		expect(advisory).toContain('architect');
		expect(advisory).toContain(TASK);
		expect(advisory.toUpperCase()).toContain('UNKNOWN');
	});

	test('idle sessions record nothing (absence of authority is clean)', async () => {
		const snapshot = bootSessionWithInFlightExecution(false);
		await crossBoundary(snapshot);
		const file = readRestartReconciliation(project);
		expect(file.entries).toHaveLength(0);
	});

	test('repeated restart dedupes by (session, task) instead of appending', async () => {
		const snapshot = bootSessionWithInFlightExecution();
		await crossBoundary(snapshot);
		await crossBoundary(snapshot);
		const file = readRestartReconciliation(project);
		expect(file.entries).toHaveLength(1);
	});

	test('durable artifact write fail-open: rehydrate still applies', async () => {
		const snapshot = bootSessionWithInFlightExecution();
		// Make the artifact path unwritable by creating a directory where the
		// file must land — the reconciliation append fails, the rehydrate
		// still applies, and the session is restored.
		const swarmSessionDir = path.join(project, '.swarm', 'session');
		mkdirSync(swarmSessionDir, { recursive: true });
		rmSync(path.join(swarmSessionDir, 'restart-reconciliation.json'), {
			force: true,
		});
		mkdirSync(path.join(swarmSessionDir, 'restart-reconciliation.json'), {
			recursive: true,
		});
		resetSwarmStatePreservingSingletons();
		const scope = beginHydrationScope(project);
		const outcome = await rehydrateState(snapshot, project, scope);
		expect(outcome.applied).toBe(true);
		expect(getAgentSession(SESSION)?.agentName).toBe('architect');
	});

	test('artifact cap: overflow drops the OLDEST entries (bounded)', async () => {
		for (let i = 0; i < 52; i += 1) {
			await recordInterruptedExecution(project, {
				sessionId: `sess-${i}`,
				agentName: 'architect',
				taskId: TASK,
			});
		}
		const file = readRestartReconciliation(project);
		expect(file.entries.length).toBeLessThanOrEqual(50);
		expect(file.entries[0].sessionId).toBe('sess-51');
	});

	test('malformed artifact reads as empty and heals on the next append', () => {
		const swarmSessionDir = path.join(project, '.swarm', 'session');
		mkdirSync(swarmSessionDir, { recursive: true });
		writeFileSync(
			path.join(swarmSessionDir, 'restart-reconciliation.json'),
			'{corrupt',
		);
		expect(readRestartReconciliation(project).entries).toHaveLength(0);
	});
});

describe('durable override row teardown in lockstep with the session (#2668)', () => {
	test('endAgentSession deletes the durable row', async () => {
		setOverrideForSession(project, SESSION, { mutation_test: true });
		const snapshot = bootSessionWithInFlightExecution();
		await crossBoundary(snapshot);
		expect(getOverrideForSession(project, SESSION)).toEqual({
			mutation_test: true,
		});
		endAgentSession(SESSION, project);
		expect(swarmState.agentSessions.has(SESSION)).toBe(false);
		expect(getOverrideForSession(project, SESSION)).toEqual({});
	});

	test('sweepStaleSessions deletes the durable row for the evicted session', async () => {
		setOverrideForSession(project, SESSION, { mutation_test: true });
		const snapshot = bootSessionWithInFlightExecution();
		const restored = await crossBoundary(snapshot);
		// A live post-restart session takes ownership on its first tool
		// invocation (ensureAgentSession claims it); mirror that here so the
		// durable teardown follows the same locally-owned path as the
		// snapshot rows.
		const { ensureAgentSession } = require('../../../src/state.js') as {
			ensureAgentSession: (id: string, agent?: string, dir?: string) => unknown;
		};
		ensureAgentSession(SESSION, 'architect', project);
		// Force the session stale, then sweep with the directory in hand.
		restored!.lastToolCallTime = Date.now() - 3 * 7_200_000;
		sweepStaleSessions(7_200_000, Date.now(), project);
		expect(swarmState.agentSessions.has(SESSION)).toBe(false);
		expect(getOverrideForSession(project, SESSION)).toEqual({});
	});
});
