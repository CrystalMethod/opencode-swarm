/**
 * Issue #2667 / PR #2742 review PRR-001 — population must respect the same
 * protected-live predicate as eviction.
 *
 * A hydration whose snapshot (written by a previous process) still carries a
 * sessionId that exists as a LIVE same-project session created after that
 * hydration began (hydrationStamp > generation) must NOT overwrite the live
 * object: eviction spares it, and population previously replaced it —
 * discarding unsnapshotted in-memory state and downgrading the stamp.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { beginHydrationScope } from '../../../src/session/hydration-ownership';
import { rehydrateState } from '../../../src/session/snapshot-reader';
import type { SnapshotData } from '../../../src/session/snapshot-writer';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempDirs: string[] = [];

function makeProject(prefix: string): string {
	const dir = canonicalMkdtemp(`${prefix}-populate-`);
	tempDirs.push(dir);
	mkdirSync(path.join(dir, '.swarm', 'session'), { recursive: true });
	return dir;
}

function snapshotWith(sessionId: string, agentName: string): SnapshotData {
	return {
		version: 3,
		writtenAt: 1,
		toolAggregates: {},
		activeAgent: { [sessionId]: agentName },
		delegationChains: {},
		agentSessions: {
			[sessionId]: {
				agentName,
				lastToolCallTime: 1,
				lastAgentEventTime: 1,
				delegationActive: false,
			},
		},
	} as unknown as SnapshotData;
}

beforeEach(() => {
	resetSwarmState();
});

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('population guard for live newer-stamped sessions (PRR-001)', () => {
	test('snapshot entry does not overwrite a live same-project session with a newer stamp', async () => {
		const dir = makeProject('guard-live');
		// Hydration begins (generation 1)…
		const scope = beginHydrationScope(dir);
		// …and a host-resumed session is created live while it is in flight
		// (stamp = current + 1 = 2 > 1), exactly the coordination-init window.
		startAgentSession('sess-X', 'architect', undefined, dir);
		const live = swarmState.agentSessions.get('sess-X');
		live?.gateLog.set('task-1', new Set(['pre_check']));
		if (live) live.architectWriteCount = 3;
		const liveActive = swarmState.activeAgent.get('sess-X');

		// The previous process's snapshot still lists sess-X as 'coder'.
		const outcome = await rehydrateState(
			snapshotWith('sess-X', 'coder'),
			dir,
			scope,
		);
		expect(outcome.applied).toBe(true);

		// The live object survives untouched — state, satellites, and stamp.
		const preserved = swarmState.agentSessions.get('sess-X');
		expect(preserved).toBe(live);
		expect(preserved?.agentName).toBe('architect');
		expect(preserved?.hydrationStamp).toBe(2);
		expect(preserved?.architectWriteCount).toBe(3);
		expect(preserved?.gateLog.get('task-1')?.has('pre_check')).toBe(true);
		expect(swarmState.activeAgent.get('sess-X')).toBe(liveActive);
	});

	test('snapshot-only and own-stale sessions are still replaced (own-replace intact)', async () => {
		const dir = makeProject('guard-replace');
		// Old-generation live session (created BEFORE this hydration began, so
		// its stamp does not protect it) plus a snapshot-only id.
		startAgentSession('sess-old', 'reviewer', undefined, dir);
		const scope = beginHydrationScope(dir);
		startAgentSession('sess-also-live', 'architect', undefined, dir);
		swarmState.agentSessions.get('sess-also-live')!.hydrationStamp = 1;

		const snapshot = snapshotWith('sess-fresh', 'coder');
		(
			snapshot as unknown as {
				agentSessions: Record<string, unknown>;
			}
		).agentSessions['sess-old'] = {
			agentName: 'coder',
			lastToolCallTime: 1,
			lastAgentEventTime: 1,
			delegationActive: false,
		};

		const outcome = await rehydrateState(snapshot, dir, scope);
		expect(outcome.applied).toBe(true);
		// Stale own session replaced from the snapshot; snapshot-only added.
		expect(swarmState.agentSessions.get('sess-old')?.agentName).toBe('coder');
		expect(swarmState.agentSessions.get('sess-fresh')?.agentName).toBe('coder');
		// The same-generation live session is not newer-stamped, so it is
		// replaced too — matching the documented own-replace semantics.
		expect(swarmState.agentSessions.get('sess-also-live')?.agentName).toBe(
			undefined,
		);
	});
});
