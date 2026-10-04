/**
 * Tests for the epic_record_divergence tool.
 * File: tests/unit/tools/epic-record-divergence.test.ts
 *
 * Covers:
 *  - Returns 'epic-mode-not-active' when the session has no Epic Mode toggle.
 *  - Returns 'no-scope' when the task has no recorded declaration (historical
 *    v2 read keyed by the plan id), or when the plan cannot be loaded.
 *  - Returns 'no-session' when the session is unknown.
 *  - Records a divergence record on the happy path and returns the summary.
 *  - Returns 'persist-failed' when recordTaskDivergence returns null.
 *  - Reads phaseNumber from plan.json when available.
 *  - Does not throw when the plan is missing (best-effort → 'no-scope').
 *  - Returns 'attribution-unavailable' (no record) when no file attribution
 *    exists for the task.
 *  - Cross-session attribution (child coder session, other-project session)
 *    with real session state lives in
 *    epic-record-divergence-attribution.test.ts.
 *  - Real declare → phase-completing status change → 'recorded' lives in
 *    epic-record-divergence-historical.test.ts.
 *
 * Uses the _internals DI seam — no mock.module (AGENTS.md invariant 7).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { derivePlanId } from '../../../src/plan/utils';
import {
	_internals,
	executeEpicRecordDivergence,
} from '../../../src/tools/epic-record-divergence';

const realInternals = { ..._internals };

interface StubState {
	epicActive: boolean;
	session: { modifiedFilesByTask?: Map<string, string[]> } | undefined;
	declaredScope: string[] | null;
	plan: {
		swarm: string;
		title: string;
		phases: Array<{ id: number; tasks: Array<{ id: string }> }>;
	} | null;
	recordResult: { path: string; record: ReturnType<typeof fakeRecord> } | null;
	recordCalls: number;
	lastPlanTitle?: string;
}

function fakeRecord(
	overrides: Partial<{
		declaredScope: string[];
		actualFiles: string[];
		undeclared: string[];
		unused: string[];
		divergenceRatio: number;
		isClean: boolean;
	}> = {},
) {
	return {
		timestamp: '2025-01-01T00:00:00Z',
		sessionID: 's1',
		taskId: 'T-1',
		phaseNumber: 1 as number | undefined,
		declaredScope: overrides.declaredScope ?? ['src/a.ts'],
		actualFiles: overrides.actualFiles ?? ['src/a.ts', 'src/b.ts'],
		undeclared: overrides.undeclared ?? ['src/b.ts'],
		unused: overrides.unused ?? [],
		divergenceRatio: overrides.divergenceRatio ?? 0.5,
		isClean: overrides.isClean ?? false,
	};
}

let stub: StubState;

beforeEach(() => {
	stub = {
		epicActive: true,
		session: {
			modifiedFilesByTask: new Map([['T-1', ['src/a.ts', 'src/b.ts']]]),
		},
		declaredScope: ['src/a.ts'],
		plan: {
			swarm: 'sw',
			title: 'Plan',
			phases: [{ id: 2, tasks: [{ id: 'T-1' }, { id: 'T-2' }] }],
		},
		recordResult: { path: '/fake/divergence.jsonl', record: fakeRecord() },
		recordCalls: 0,
	};

	_internals.isEpicModeConfigEnabledForDirectory = () => true;
	_internals.hasActiveEpicMode = (() => stub.epicActive) as never;
	_internals.getAgentSession = (() => stub.session) as never;
	_internals.readLatestEpicDeclaredScopeForCalibration = ((input: {
		plan: { title: string };
	}) => {
		stub.lastPlanTitle = input.plan.title;
		return stub.declaredScope;
	}) as never;
	// Only the stubbed architect session contributes attribution here.
	_internals.listAgentSessions = (() => []) as never;
	_internals.resetModifiedFilesForTask = (() => true) as never;
	_internals.loadPlanJsonOnly = (async () => stub.plan) as never;
	_internals.recordTaskDivergence = ((_args: unknown) => {
		stub.recordCalls += 1;
		return stub.recordResult;
	}) as never;
});

afterEach(() => {
	_internals.isEpicModeConfigEnabledForDirectory =
		realInternals.isEpicModeConfigEnabledForDirectory;
	_internals.hasActiveEpicMode = realInternals.hasActiveEpicMode;
	_internals.getAgentSession = realInternals.getAgentSession;
	_internals.readLatestEpicDeclaredScopeForCalibration =
		realInternals.readLatestEpicDeclaredScopeForCalibration;
	_internals.listAgentSessions = realInternals.listAgentSessions;
	_internals.resetModifiedFilesForTask =
		realInternals.resetModifiedFilesForTask;
	_internals.loadPlanJsonOnly = realInternals.loadPlanJsonOnly;
	_internals.recordTaskDivergence = realInternals.recordTaskDivergence;
});

describe('executeEpicRecordDivergence', () => {
	test('returns epic-mode-not-active when the session has no toggle', async () => {
		stub.epicActive = false;
		const result = await executeEpicRecordDivergence({
			directory: '/fake',
			taskId: 'T-1',
			sessionID: 's1',
		});
		expect(result.reason).toBe('epic-mode-not-active');
		expect(stub.recordCalls).toBe(0);
	});

	test('returns no-session when the session is unknown', async () => {
		stub.session = undefined;
		const result = await executeEpicRecordDivergence({
			directory: '/fake',
			taskId: 'T-1',
			sessionID: 's1',
		});
		expect(result.reason).toBe('no-session');
		expect(stub.recordCalls).toBe(0);
	});

	test('returns no-scope when the task has no declared scope', async () => {
		stub.declaredScope = null;
		const result = await executeEpicRecordDivergence({
			directory: '/fake',
			taskId: 'T-1',
			sessionID: 's1',
		});
		expect(result.reason).toBe('no-scope');
		expect(stub.recordCalls).toBe(0);
	});

	test('happy path: records divergence and returns summary', async () => {
		const result = await executeEpicRecordDivergence({
			directory: '/fake',
			taskId: 'T-1',
			sessionID: 's1',
		});
		expect(stub.recordCalls).toBe(1);
		expect(result.reason).toBe('recorded');
		expect(result.summary).toBeDefined();
		expect(result.summary?.divergenceRatio).toBe(0.5);
		expect(result.summary?.isClean).toBe(false);
		expect(result.summary?.undeclaredCount).toBe(1);
		// Historical read is keyed by the loaded plan (its id).
		expect(stub.lastPlanTitle).toBe('Plan');
	});

	test('returns persist-failed when recordTaskDivergence returns null', async () => {
		stub.recordResult = null;
		const result = await executeEpicRecordDivergence({
			directory: '/fake',
			taskId: 'T-1',
			sessionID: 's1',
		});
		expect(stub.recordCalls).toBe(1);
		expect(result.reason).toBe('persist-failed');
	});

	test('looks up the phase number from plan.json when available', async () => {
		let capturedPhase: number | undefined;
		_internals.recordTaskDivergence = ((args: { phaseNumber?: number }) => {
			capturedPhase = args.phaseNumber;
			stub.recordCalls += 1;
			return stub.recordResult;
		}) as never;

		await executeEpicRecordDivergence({
			directory: '/fake',
			taskId: 'T-1',
			sessionID: 's1',
		});
		expect(capturedPhase).toBe(2);
	});

	test('returns no-scope (no throw) when the plan is missing — no plan id to key the read', async () => {
		stub.plan = null;
		const result = await executeEpicRecordDivergence({
			directory: '/fake',
			taskId: 'T-1',
			sessionID: 's1',
		});
		expect(result.reason).toBe('no-scope');
		expect(stub.recordCalls).toBe(0);
	});

	test('omits phase number when the task is not in any phase', async () => {
		stub.plan = { swarm: 'sw', title: 'Plan', phases: [] };
		let capturedPhase: number | undefined = -1; // sentinel
		_internals.recordTaskDivergence = ((args: { phaseNumber?: number }) => {
			capturedPhase = args.phaseNumber;
			stub.recordCalls += 1;
			return stub.recordResult;
		}) as never;

		await executeEpicRecordDivergence({
			directory: '/fake',
			taskId: 'T-1',
			sessionID: 's1',
		});
		expect(capturedPhase).toBeUndefined();
	});

	test('missing attribution → attribution-unavailable, never a clean record', async () => {
		stub.session = {}; // no attribution map at all
		const result = await executeEpicRecordDivergence({
			directory: '/fake',
			taskId: 'T-1',
			sessionID: 's1',
		});
		expect(result.reason).toBe('attribution-unavailable');
		expect(result.summary).toBeUndefined();
		expect(stub.recordCalls).toBe(0);
	});

	test('present-but-empty attribution → attribution-unavailable', async () => {
		stub.session = { modifiedFilesByTask: new Map([['T-1', []]]) };
		const result = await executeEpicRecordDivergence({
			directory: '/fake',
			taskId: 'T-1',
			sessionID: 's1',
		});
		expect(result.reason).toBe('attribution-unavailable');
		expect(stub.recordCalls).toBe(0);
	});

	test('passes the canonicalized attributed files as actualFiles', async () => {
		let capturedActual: string[] | undefined;
		_internals.recordTaskDivergence = ((args: { actualFiles: string[] }) => {
			capturedActual = args.actualFiles;
			stub.recordCalls += 1;
			return stub.recordResult;
		}) as never;
		await executeEpicRecordDivergence({
			directory: '/fake',
			taskId: 'T-1',
			sessionID: 's1',
		});
		expect(capturedActual).toEqual(['src/a.ts', 'src/b.ts']);
	});

	test('config master gate off → epic-disabled-by-config with remediation, nothing recorded (F7d)', async () => {
		_internals.isEpicModeConfigEnabledForDirectory = () => false;
		const result = await executeEpicRecordDivergence({
			directory: '/fake',
			taskId: 'T-1',
			sessionID: 's1',
		});
		expect(result.reason).toBe('epic-disabled-by-config');
		expect(result.message).toContain('turbo.epic.mode.enabled');
		expect(stub.recordCalls).toBe(0);
	});

	test('passes the plan id so recording is idempotent per (planId, taskId) (F2)', async () => {
		let seenPlanId: string | undefined;
		_internals.recordTaskDivergence = ((args: { planId?: string }) => {
			seenPlanId = args.planId;
			return stub.recordResult;
		}) as never;
		await executeEpicRecordDivergence({
			directory: '/fake',
			taskId: 'T-1',
			sessionID: 's1',
		});
		expect(seenPlanId).toBe(derivePlanId({ swarm: 'sw', title: 'Plan' }));
	});

	test('a duplicate record reports already-recorded (F2)', async () => {
		_internals.recordTaskDivergence = (() => ({
			...stub.recordResult,
			duplicate: true,
		})) as never;
		const result = await executeEpicRecordDivergence({
			directory: '/fake',
			taskId: 'T-1',
			sessionID: 's1',
		});
		expect(result.reason).toBe('already-recorded');
		expect(result.summary?.actualCount).toBe(2);
	});
});
