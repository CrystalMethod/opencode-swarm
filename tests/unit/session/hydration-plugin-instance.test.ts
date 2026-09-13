/**
 * Issue #2667 — two REAL plugin instances hydrate independently.
 *
 * Boots the actual plugin server() twice over two disposable projects
 * (tests/helpers/plugin-host.ts), drives live session state through the
 * REGISTERED chat.message hook (the delegation-tracker creation path — the
 * threading pin for src/hooks/delegation-tracker.ts:42/68), and asserts each
 * instance's state survives the other's real init/hydration path
 * (loadSnapshot in server() + the post-resolution SQLite coordination task).
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { forceRecordPlanCriticApproval } from '../../../src/hooks/delegation-gate';
import { hydrationProjectKey } from '../../../src/session/hydration-ownership';
import {
	SNAPSHOT_PROJECTION_FILE,
	type SnapshotData,
} from '../../../src/session/snapshot-writer';
import { resetSwarmState, swarmState } from '../../../src/state';
import {
	type BootedPluginHost,
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../../helpers/plugin-host';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const cleanupDirs: string[] = [];

function projectWithSnapshot(prefix: string, sessionId: string): string {
	const dir = createPluginHostProject(prefix);
	cleanupDirs.push(dir);
	mkdirSync(path.join(dir, '.swarm', 'session'), { recursive: true });
	const snapshot: SnapshotData = {
		version: 3,
		writtenAt: 1,
		toolAggregates: {},
		activeAgent: { [sessionId]: 'coder' },
		delegationChains: {},
		agentSessions: {
			[sessionId]: {
				agentName: 'coder',
				lastToolCallTime: 1,
				lastAgentEventTime: 1,
				delegationActive: false,
			},
		},
	} as unknown as SnapshotData;
	writeFileSync(
		path.join(dir, '.swarm', 'session', 'state.json'),
		JSON.stringify(snapshot),
	);
	return dir;
}

type ChatMessageHook = (
	input: { sessionID: string; agent?: string },
	output: Record<string, unknown>,
) => Promise<unknown>;

function chatMessageHook(host: BootedPluginHost): ChatMessageHook {
	const hook = host.hooks['chat.message'];
	if (typeof hook !== 'function') {
		throw new Error('chat.message hook missing from booted plugin host');
	}
	return hook as ChatMessageHook;
}

/** Fixed macrotask drain so each boot's setTimeout(0) post-resolution queue runs. */
async function drainPostResolution(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function driveLiveSession(
	host: BootedPluginHost,
	sessionId: string,
): Promise<void> {
	await chatMessageHook(host)({ sessionID: sessionId, agent: 'architect' }, {});
	await drainPostResolution(25);
}

beforeEach(() => {
	resetSwarmState();
});

afterAll(() => {
	for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

describe('two real plugin instances (issue #2667 AC1)', () => {
	test('instance A live state survives instance B boot hydration, both restored/created states coexist', async () => {
		const dirA = createPluginHostProject('pi-a-live-');
		cleanupDirs.push(dirA);
		const dirB = projectWithSnapshot('pi-b-snap-', 'sess-b-snap');

		const hostA = await bootSwarmPluginHost(dirA);
		await driveLiveSession(hostA, 'sess-a-live');
		expect(swarmState.agentSessions.has('sess-a-live')).toBe(true);

		// Instance B boots in the SAME process: its real init hydration must
		// not evict instance A's live session (the pre-fix defect).
		await bootSwarmPluginHost(dirB);
		await drainPostResolution(150);

		expect(swarmState.agentSessions.has('sess-a-live')).toBe(true);
		expect(swarmState.activeAgent.get('sess-a-live')).toBe('architect');
		expect(swarmState.agentSessions.has('sess-b-snap')).toBe(true);
	});

	test('chat.message-created sessions carry the instance project key (delegation-tracker threading pin)', async () => {
		const dirA = createPluginHostProject('pi-a-pin-');
		cleanupDirs.push(dirA);
		const hostA = await bootSwarmPluginHost(dirA);
		await driveLiveSession(hostA, 'sess-pin');
		const session = swarmState.agentSessions.get('sess-pin');
		expect(session?.owningProjectKey).toBe(hydrationProjectKey(dirA));
		expect(typeof session?.hydrationStamp).toBe('number');
	});

	test('second live session on A survives a fresh B boot with a newer snapshot', async () => {
		const dirA = createPluginHostProject('pi-a2-');
		cleanupDirs.push(dirA);
		const hostA = await bootSwarmPluginHost(dirA);
		await driveLiveSession(hostA, 'sess-a2-live');
		expect(swarmState.agentSessions.has('sess-a2-live')).toBe(true);

		const dirB2 = projectWithSnapshot('pi-b2-snap-', 'sess-b2-snap');
		await bootSwarmPluginHost(dirB2);
		await drainPostResolution(150);
		expect(swarmState.agentSessions.has('sess-a2-live')).toBe(true);
		expect(swarmState.agentSessions.has('sess-b2-snap')).toBe(true);
	});
});

describe('delegation-gate parent-site threading pin (issue #2667 §6)', () => {
	test('session created via forceRecordPlanCriticApproval is stamped with its directory (site src/hooks/delegation-gate.ts forceRecord* helper)', async () => {
		const dir = canonicalMkdtemp('pi-gate-pin-');
		cleanupDirs.push(dir);
		mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		// The helper creates the session BEFORE its architect validation
		// rejects a non-architect caller — the expected rejection still leaves
		// the ownership-stamped session behind, which is what this pins.
		await expect(
			forceRecordPlanCriticApproval(dir, 'sess-gate-pin', {
				reason: 'threading pin',
			}),
		).rejects.toThrow();
		const session = swarmState.agentSessions.get('sess-gate-pin');
		expect(session?.owningProjectKey).toBe(hydrationProjectKey(dir));
	});
});
