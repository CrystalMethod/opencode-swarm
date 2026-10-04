/**
 * Tests for the /swarm epic slash command.
 * File: tests/unit/commands/epic.test.ts
 *
 * Covers:
 *  - Missing session context → friendly error.
 *  - Removed v1 `on` / `off` toggles fall to the usage text; bare form is
 *    status and never mutates the epic.
 *  - status renders the lifecycle record (waves, phases, divergence,
 *    orphan, config).
 *  - the removed `decide` / `last` subcommands answer with a pointer to
 *    status and mutate nothing.
 * Lifecycle collaborators are replaced through `_internals` (AGENTS.md #7).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _internals, handleEpicCommand } from '../../../src/commands/epic';
import type { EpicInspection } from '../../../src/turbo/epic/lifecycle';
import { stubEpicRecord } from '../../helpers/epic-lifecycle';

const realInternals = { ..._internals };

let startCalls = 0;
let closeCalls = 0;
let inspection: EpicInspection;

function emptyInspection(): EpicInspection {
	return {
		sentinelPresent: false,
		sentinel: null,
		record: null,
		rowKeys: [],
		unreadable: null,
		orphanReason: null,
		configEnabled: true,
	};
}

beforeEach(() => {
	startCalls = 0;
	closeCalls = 0;
	inspection = emptyInspection();
	_internals.inspectEpic = (() => inspection) as never;
	_internals.repairEpicSentinel = (() => 'none') as never;
	_internals.retireLegacyEpicSessionState = (() => ({
		rowsRemoved: 0,
		activeSessions: 0,
		fileArchivedTo: null,
		errors: [],
	})) as never;
	_internals.describeMergeFailuresForStatus = (() => []) as never;
	_internals.startEpic = (async () => {
		startCalls += 1;
		throw new Error('unexpected start');
	}) as never;
	_internals.closeEpic = (async () => {
		closeCalls += 1;
		throw new Error('unexpected close');
	}) as never;
	_internals.loadPluginConfigWithMeta = (() => ({
		config: { turbo: { epic: { mode: { enabled: true } } } },
		isUsingDefaults: false,
	})) as never;
	_internals.loadPlanJsonOnly = (async () => ({
		phases: [
			{
				id: 1,
				name: 'P1',
				tasks: [
					{
						id: '1.1',
						description: 'a',
						status: 'pending',
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	})) as never;
	_internals.resolvePlanMarkerScope = (async () => ({
		planKey: 'aaaaaaaaaaaaaaaa',
		rootTimestampMs: null,
	})) as never;
});

afterEach(() => {
	for (const k of Object.keys(realInternals)) {
		(_internals as never as Record<string, unknown>)[k] = (
			realInternals as never as Record<string, unknown>
		)[k];
	}
});

describe('handleEpicCommand — session validation', () => {
	test('rejects empty sessionID', async () => {
		const out = await handleEpicCommand('/fake', [], '');
		expect(out).toContain('No active session context');
	});
});

describe('handleEpicCommand — subcommand routing', () => {
	test.each([
		['on'],
		['off'],
	])('removed v1 toggle `%s` gets a migration hint and mutates nothing', async (arg) => {
		const out = await handleEpicCommand('/fake', [arg], 'sess-1');
		expect(out).toContain(`\`/swarm epic ${arg}\` was removed in Epic v2`);
		expect(out).toContain('Use `/swarm epic start`');
		expect(out).toContain(
			'/swarm epic start [--force] | close [--abandon] [--land squash|merge|none] | status [--repair-refs] | calibration | clear-merge-failure <taskId> [--confirm]',
		);
		expect(out).not.toMatch(/\bon \| off\b/);
		expect(startCalls).toBe(0);
		expect(closeCalls).toBe(0);
	});

	test('bare `/swarm epic` shows status and never starts or closes (anti-loop)', async () => {
		const out = await handleEpicCommand('/fake', [], 'sess-1');
		expect(out).toContain('Epic Mode — Status');
		await handleEpicCommand('/fake', [], 'sess-1');
		expect(startCalls).toBe(0);
		expect(closeCalls).toBe(0);
	});

	test.each([
		['decide'],
		['last'],
	])('removed `%s` points at status and the architect flow', async (arg) => {
		const out = await handleEpicCommand('/fake', [arg], 'sess-1');
		expect(out).toContain(`\`/swarm epic ${arg}\` was removed in Epic v2`);
		expect(out).toContain('`epic_next_wave` plans every wave');
		expect(out).toContain('`/swarm epic status`');
		expect(startCalls).toBe(0);
		expect(closeCalls).toBe(0);
	});

	test('empty-string subcommand is treated as unknown', async () => {
		const out = await handleEpicCommand('/fake', [''], 'sess-1');
		expect(out).toContain("Unknown subcommand ''");
		expect(startCalls).toBe(0);
	});
});

describe('handleEpicCommand — status', () => {
	test('no epic → says so and points at `/swarm epic start`', async () => {
		const out = await handleEpicCommand('/fake', ['status'], 'sess-1');
		expect(out).toContain('No epic is open. Run `/swarm epic start`');
	});

	test('unreadable lifecycle state is reported with the --abandon repair', async () => {
		inspection.unreadable = 'Epic lifecycle row is not valid JSON';
		const out = await handleEpicCommand('/fake', ['status'], 'sess-1');
		expect(out).toContain('**Epic lifecycle state is unreadable**');
		expect(out).toContain('`/swarm epic close --abandon`');
		expect(out).not.toContain('No epic is open');
	});

	test('renders the open epic with its waves, phases and divergence', async () => {
		inspection.record = stubEpicRecord({
			activeWaveSeq: 2,
			waves: [
				{
					seq: 1,
					phase: 1,
					kind: 'parallel',
					taskIds: ['1.1', '1.2'],
					files: { '1.1': ['src/a.ts'], '1.2': ['src/b.ts'] },
					cochange: null,
					baseHead: null,
					issuedAt: '2026-01-01T00:00:00.000Z',
					closedAt: '2026-01-01T01:00:00.000Z',
					closeHead: null,
					status: 'closed',
					undeclared: ['src/stray.ts'],
				},
				{
					seq: 2,
					phase: 1,
					kind: 'exclusive',
					taskIds: ['1.3'],
					files: { '1.3': ['package.json'] },
					cochange: null,
					baseHead: null,
					issuedAt: '2026-01-01T02:00:00.000Z',
					status: 'issued',
				},
			],
			tasks: {
				'1.1': {
					taskId: '1.1',
					phase: 1,
					waveSeq: 1,
					resolution: 'completed',
					resolvedAt: '2026-01-01T00:30:00.000Z',
					generation: 1,
					stageAFailures: 0,
					stageBFailures: 0,
					mergeFailure: null,
					declared: ['src/a.ts'],
					undeclared: ['src/c.ts'],
					attribution: 'session',
					reopened: 0,
					marker: null,
				},
			},
			phases: {
				'1': {
					status: 'active',
					reviewRuns: 1,
					verdicts: ['reviewer:NEEDS_REVISION critic:not-run'],
				},
			},
		});
		const out = await handleEpicCommand('/fake', ['status'], 'sess-1');
		expect(out).toContain(`Epic: \`${inspection.record.epicKey}\` — **open**`);
		expect(out).toContain('- 2 issued: 1 closed.');
		expect(out).toContain(
			'**Active:** wave 2 (phase 1, exclusive) — 1.3 — issued 2026-01-01T02:00:00.000Z',
		);
		expect(out).toContain(
			'Phase 1: active; 1 phase review run(s) (last: reviewer:NEEDS_REVISION critic:not-run)',
		);
		expect(out).toContain('- 1.1 (wave 1): src/c.ts');
		expect(out).toContain('- wave 1 (unattributed): src/stray.ts');
		expect(out).not.toContain('activation decision');
	});

	test('an epic without waves says the architect issues the first one', async () => {
		inspection.record = stubEpicRecord();
		const out = await handleEpicCommand('/fake', ['status'], 'sess-1');
		expect(out).toContain('None issued yet');
		expect(out).not.toContain('Divergence');
	});

	test('orphaned epic and closed config gate are both explained', async () => {
		inspection.record = stubEpicRecord();
		inspection.orphanReason = 'plan-renamed-or-replaced';
		inspection.configEnabled = false;
		const out = await handleEpicCommand('/fake', ['status'], 'sess-1');
		expect(out).toContain('— **orphaned**');
		expect(out).toContain('the plan was renamed or replaced');
		expect(out).toContain('`/swarm epic close --abandon`');
		expect(out).toContain('`turbo.epic.mode.enabled` is not true');
	});

	test('reports a sentinel repair and the legacy v1 retirement', async () => {
		_internals.repairEpicSentinel = (() => 'removed-stale-sentinel') as never;
		_internals.retireLegacyEpicSessionState = (() => ({
			rowsRemoved: 2,
			activeSessions: 1,
			fileArchivedTo: '.swarm/epic-state.json.imported',
			errors: [],
		})) as never;
		const out = await handleEpicCommand('/fake', ['status'], 'sess-1');
		expect(out).toContain('Repaired: removed a stale sentinel');
		expect(out).toContain('Retired Epic v1 per-session state (2 row(s)');
		expect(out).toContain('1 session(s) had Epic v1 switched on');
		expect(out).toContain('run `/swarm epic start`');
	});
});

describe('handleEpicCommand — calibration (Capability D state)', () => {
	test('returns "no state yet" + static threshold when state is null (clean repo)', async () => {
		_internals.loadCalibrationState = (() => null) as never;
		_internals.isCalibrationStateUnreadable = (() => false) as never;
		_internals.readDivergenceHistory = (() => []) as never;
		const out = await handleEpicCommand('/fake', ['calibration'], 'sess-1');
		expect(out).toContain('Epic Mode — Calibration');
		expect(out).toContain('No calibration state yet');
		// Static threshold from default config (0.3) must be surfaced.
		expect(out).toContain('0.300');
	});

	test('returns fail-closed message when calibration state is unreadable', async () => {
		_internals.isCalibrationStateUnreadable = (() => true) as never;
		const out = await handleEpicCommand('/fake', ['calibration'], 'sess-1');
		expect(out).toContain('unreadable (fail-closed)');
		expect(out).toContain('static config defaults');
	});

	test('renders effective threshold + tightening delta when override is set', async () => {
		_internals.isCalibrationStateUnreadable = (() => false) as never;
		_internals.loadCalibrationState = (() => ({
			version: 1 as const,
			updatedAt: '2026-05-28T10:00:00Z',
			activationThresholdOverride: 0.22,
			hotModuleAdditions: ['src/global.ts', 'src/init.ts'],
			consecutiveCleanCount: 3,
			lastCalibrationAt: '2026-05-28T09:45:00Z',
			processedRecords: 17,
		})) as never;
		_internals.readDivergenceHistory = (() => [
			{
				timestamp: '2026-05-28T09:00:00Z',
				sessionID: 's',
				taskId: 'T-2.4',
				declaredScope: ['src/foo.ts'],
				actualFiles: ['src/foo.ts', 'src/global.ts'],
				undeclared: ['src/global.ts'],
				unused: [],
				divergenceRatio: 0.5,
				isClean: false,
			},
		]) as never;
		const out = await handleEpicCommand('/fake', ['calibration'], 'sess-1');
		// Static and effective both shown with delta.
		expect(out).toContain('Static threshold (config): 0.300');
		expect(out).toContain('Effective threshold (learned)**: 0.220');
		expect(out).toContain('tightened by 0.080');
		// Counter + window from defaults.
		expect(out).toContain('Consecutive clean tasks: 3 / 10');
		// Hot module entries listed.
		expect(out).toContain('src/global.ts');
		expect(out).toContain('src/init.ts');
		// Recent divergent rendered with undeclared sample.
		expect(out).toContain('T-2.4');
		expect(out).toContain('ratio=0.50');
	});

	test('says "using static" when no override is set', async () => {
		_internals.isCalibrationStateUnreadable = (() => false) as never;
		_internals.loadCalibrationState = (() => ({
			version: 1 as const,
			updatedAt: '2026-05-28T10:00:00Z',
			hotModuleAdditions: [],
			consecutiveCleanCount: 0,
			processedRecords: 0,
		})) as never;
		_internals.readDivergenceHistory = (() => []) as never;
		const out = await handleEpicCommand('/fake', ['calibration'], 'sess-1');
		expect(out).toContain('using static — no calibration override');
		expect(out).toContain("hasn't promoted any modules");
		expect(out).toContain('None recent');
	});

	test('truncates long hot-module list at 10 entries with summary line', async () => {
		_internals.isCalibrationStateUnreadable = (() => false) as never;
		const lotsOfModules = Array.from({ length: 14 }, (_, i) => `src/m${i}.ts`);
		_internals.loadCalibrationState = (() => ({
			version: 1 as const,
			updatedAt: '2026-05-28T10:00:00Z',
			hotModuleAdditions: lotsOfModules,
			consecutiveCleanCount: 0,
			processedRecords: 20,
		})) as never;
		_internals.readDivergenceHistory = (() => []) as never;
		const out = await handleEpicCommand('/fake', ['calibration'], 'sess-1');
		expect(out).toContain('src/m0.ts');
		expect(out).toContain('src/m9.ts');
		expect(out).toContain('+4 more');
		// m10..m13 should not appear individually.
		expect(out).not.toContain('src/m12.ts');
	});
});
