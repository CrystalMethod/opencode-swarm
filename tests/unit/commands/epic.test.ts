/**
 * Tests for the /swarm epic slash command.
 * File: tests/unit/commands/epic.test.ts
 *
 * Covers:
 *  - Missing session context → friendly error.
 *  - Removed v1 `on` / `off` toggles fall to the usage text; bare form is
 *    status and never mutates the epic.
 *  - status renders the lifecycle record (last decision, orphan, config).
 *  - decide computes a fresh verdict from the plan without writing evidence.
 * Lifecycle collaborators are replaced through `_internals` (AGENTS.md #7).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _internals, handleEpicCommand } from '../../../src/commands/epic';
import type { EpicInspection } from '../../../src/turbo/epic/lifecycle';
import { stubEpicRecord } from '../../helpers/epic-lifecycle';

const realInternals = { ..._internals };

let decideCalls = 0;
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
	decideCalls = 0;
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
	_internals.resolveEpicDeclaredScopes = () => ({}); // no live v2 bindings

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
	_internals.getCoChangeData = (async () => ({
		pairs: [],
		commitsObserved: 50,
	})) as never;
	_internals.decideEpicActivation = (() => {
		decideCalls += 1;
		return {
			decision: 'promote',
			p: 0,
			rationale: {
				pCheck: { passed: true, p: 0, threshold: 0.3 },
				hotModuleCheck: { passed: true, touchedHotModules: [] },
				greenfieldCheck: { passed: true, commitsObserved: 50, minCommits: 20 },
			},
			blockingReasons: [],
		};
	}) as never;
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
			'/swarm epic start [--force] | close [--abandon] [--land squash|merge|none] | status | decide | last | calibration | clear-merge-failure <taskId> [--confirm]',
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

	test('renders the open epic and its last decision', async () => {
		inspection.record = stubEpicRecord({
			lastDecision: {
				decidedAt: '2025-01-02T00:00:00Z',
				phase: 2,
				decision: 'demote',
				p: 0.75,
				blockingReasons: ['p exceeds threshold'],
			},
		});
		const out = await handleEpicCommand('/fake', ['status'], 'sess-1');
		expect(out).toContain(`Epic: \`${inspection.record.epicKey}\` — **open**`);
		expect(out).toContain('Last activation decision');
		expect(out).toContain('demote');
		expect(out).toContain('0.750');
		expect(out).toContain('p exceeds threshold');
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

describe('handleEpicCommand — decide (read-only what-if)', () => {
	test('returns a verdict rendering without dispatching execution', async () => {
		const out = await handleEpicCommand('/fake', ['decide'], 'sess-1');
		expect(out).toContain('Epic Mode — Activation Decision');
		expect(out).toContain('promote');
		expect(decideCalls).toBe(1);
	});

	test('does not write evidence (read-only)', async () => {
		// The evidence writer isn't bound to a seam in `decide`, but we can
		// at least verify the no-plan path produces a friendly message
		// instead of attempting a write.
		_internals.loadPlanJsonOnly = (async () => null) as never;
		const out = await handleEpicCommand('/fake', ['decide'], 'sess-1');
		expect(out).toContain('No plan found');
	});

	test('Phase 15 (B38): decide-path renders phantom-only failure with the typo, not empty "missing upstreams:"', async () => {
		_internals.decideEpicActivation = (() => ({
			decision: 'demote' as const,
			p: 0.05,
			rationale: {
				pCheck: { passed: true, p: 0.05, threshold: 0.3 },
				hotModuleCheck: { passed: true, touchedHotModules: [] },
				greenfieldCheck: {
					passed: false,
					commitsObserved: 4,
					minCommits: 20,
					crossPhaseUpstreams: [],
					missingUpstreams: [],
					phantomDeps: ['1.7', '2.99'],
				},
			},
			blockingReasons: [
				'phantom dep id(s) declared but not present in plan (probable typo, fix the dep id) — 1.7, 2.99',
			],
		})) as never;

		const out = await handleEpicCommand('/fake', ['decide'], 'sess-1');
		// The phantom typo IDs appear on the greenfield gate line itself.
		expect(out).toContain('phantom dep ids');
		expect(out).toContain('1.7');
		expect(out).toContain('2.99');
		// And there is no misleading empty "missing upstreams: " segment.
		expect(out).not.toMatch(/missing upstreams: ?\n/);
	});

	test('Phase 15 (B38): decide-path renders mixed phantom+missing failure with both segments', async () => {
		_internals.decideEpicActivation = (() => ({
			decision: 'demote' as const,
			p: 0.05,
			rationale: {
				pCheck: { passed: true, p: 0.05, threshold: 0.3 },
				hotModuleCheck: { passed: true, touchedHotModules: [] },
				greenfieldCheck: {
					passed: false,
					commitsObserved: 10,
					minCommits: 20,
					crossPhaseUpstreams: ['1.1'],
					missingUpstreams: ['1.1'],
					phantomDeps: ['2.99'],
				},
			},
			blockingReasons: [],
		})) as never;

		const out = await handleEpicCommand('/fake', ['decide'], 'sess-1');
		expect(out).toContain('phantom dep ids');
		expect(out).toContain('2.99');
		expect(out).toContain('missing upstreams');
		expect(out).toContain('1.1');
	});

	test('Phase 15 (B38): decide-path renders vacuous-pass when no cross-phase upstreams', async () => {
		_internals.decideEpicActivation = (() => ({
			decision: 'promote' as const,
			p: 0.05,
			rationale: {
				pCheck: { passed: true, p: 0.05, threshold: 0.3 },
				hotModuleCheck: { passed: true, touchedHotModules: [] },
				greenfieldCheck: {
					passed: true,
					commitsObserved: 0,
					minCommits: 20,
					crossPhaseUpstreams: [],
					missingUpstreams: [],
				},
			},
			blockingReasons: [],
		})) as never;

		const out = await handleEpicCommand('/fake', ['decide'], 'sess-1');
		expect(out).toContain('vacuous');
	});

	test('Phase 15 (B38): decide-path tolerates legacy rationale without crashing', async () => {
		// A pre-Phase-10 verdict shape (no crossPhaseUpstreams /
		// missingUpstreams / phantomDeps on greenfieldCheck). The
		// renderer must default these to [] and not throw.
		_internals.decideEpicActivation = (() => ({
			decision: 'demote' as const,
			p: 0.5,
			rationale: {
				pCheck: { passed: false, p: 0.5, threshold: 0.3 },
				hotModuleCheck: { passed: true, touchedHotModules: [] },
				greenfieldCheck: {
					passed: false,
					commitsObserved: 0,
					minCommits: 20,
				},
			},
			blockingReasons: ['p too high'],
		})) as never;

		const out = await handleEpicCommand('/fake', ['decide'], 'sess-1');
		expect(out).toContain('legacy record');
	});
});

describe('handleEpicCommand — last (most recent decision from evidence)', () => {
	test('returns a "no decisions yet" message when the evidence file is empty', async () => {
		_internals.readPromotionEvidence = (() => []) as never;
		const out = await handleEpicCommand('/fake', ['last'], 'sess-1');
		expect(out).toContain('Epic Mode — Last Decision');
		expect(out).toContain('No decisions recorded yet');
		expect(out).toContain('run `/swarm epic decide`');
	});

	test('renders the most recent record with verdict, p, and gate-by-gate', async () => {
		_internals.readPromotionEvidence = (() => [
			{
				timestamp: '2026-05-27T11:00:00Z',
				sessionID: 'sess-prior',
				phase: 1,
				verdict: {
					decision: 'promote' as const,
					p: 0.12,
					rationale: {
						pCheck: { passed: true, p: 0.12, threshold: 0.3 },
						hotModuleCheck: { passed: true, touchedHotModules: [] },
						greenfieldCheck: {
							passed: true,
							commitsObserved: 80,
							minCommits: 20,
						},
					},
					blockingReasons: [],
				},
			},
			{
				timestamp: '2026-05-28T09:30:00Z',
				sessionID: 'sess-current',
				phase: 2,
				verdict: {
					decision: 'demote' as const,
					p: 0.55,
					rationale: {
						pCheck: { passed: false, p: 0.55, threshold: 0.3 },
						hotModuleCheck: {
							passed: false,
							touchedHotModules: ['src/global.ts'],
						},
						greenfieldCheck: {
							passed: true,
							commitsObserved: 50,
							minCommits: 20,
						},
					},
					blockingReasons: [
						'p (0.550) exceeds activation threshold (0.300)',
						'plan touches Lean Turbo hot module(s): src/global.ts',
					],
				},
			},
		]) as never;

		const out = await handleEpicCommand('/fake', ['last'], 'sess-1');
		// Must show the LAST (second) record, not the first.
		expect(out).toContain('Decided at: 2026-05-28T09:30:00Z');
		expect(out).toContain('Session: sess-current');
		expect(out).toContain('Phase: 2');
		expect(out).toContain('Decision: **demote**');
		expect(out).toContain('p: 0.550');
		expect(out).toContain('p (0.550) exceeds activation threshold (0.300)');
		expect(out).toContain('plan touches Lean Turbo hot module(s)');
		// Gate-by-gate section
		expect(out).toContain('p-threshold');
		expect(out).toContain('hot-module');
		expect(out).toContain('greenfield');
		expect(out).toContain('src/global.ts');
		// History footer when records.length > 1
		expect(out).toContain('2 decisions total');
	});

	test('surfaces read errors as a friendly message rather than throwing', async () => {
		_internals.readPromotionEvidence = (() => {
			throw new Error('disk fell off');
		}) as never;
		const out = await handleEpicCommand('/fake', ['last'], 'sess-1');
		expect(out).toContain('Error reading epic-promotions.jsonl');
		expect(out).toContain('disk fell off');
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

describe('Phase 14 (B26) — renderer surfaces phantomDeps on the greenfield line', () => {
	test('failing gate with phantom deps only ⇒ renderer names the typo, not "missing upstreams:" with empty list', async () => {
		_internals.readPromotionEvidence = (() => [
			{
				timestamp: '2026-06-03T12:00:00Z',
				sessionID: 'sess-1',
				phase: 2,
				verdict: {
					decision: 'demote' as const,
					p: 0.05,
					rationale: {
						pCheck: { passed: true, p: 0.05, threshold: 0.3 },
						hotModuleCheck: { passed: true, touchedHotModules: [] },
						greenfieldCheck: {
							passed: false,
							commitsObserved: 4,
							minCommits: 20,
							crossPhaseUpstreams: [],
							missingUpstreams: [],
							phantomDeps: ['1.7', '2.99'],
						},
					},
					blockingReasons: [
						'phantom dep id(s) declared but not present in plan (probable typo, fix the dep id) — 1.7, 2.99',
					],
				},
			},
		]) as never;

		const out = await handleEpicCommand('/fake', ['last'], 'sess-1');
		// The phantom typo IDs MUST appear on the greenfield line itself.
		expect(out).toContain('phantom dep ids');
		expect(out).toContain('1.7');
		expect(out).toContain('2.99');
		// And the renderer must NOT emit a misleading empty
		// "missing upstreams: " segment.
		expect(out).not.toMatch(/missing upstreams: ?\n/);
	});

	test('failing gate with BOTH phantom deps and missing upstreams ⇒ both segments surface', async () => {
		_internals.readPromotionEvidence = (() => [
			{
				timestamp: '2026-06-03T13:00:00Z',
				sessionID: 'sess-1',
				phase: 3,
				verdict: {
					decision: 'demote' as const,
					p: 0.05,
					rationale: {
						pCheck: { passed: true, p: 0.05, threshold: 0.3 },
						hotModuleCheck: { passed: true, touchedHotModules: [] },
						greenfieldCheck: {
							passed: false,
							commitsObserved: 10,
							minCommits: 20,
							crossPhaseUpstreams: ['1.1'],
							missingUpstreams: ['1.1'],
							phantomDeps: ['2.99'],
						},
					},
					blockingReasons: [],
				},
			},
		]) as never;

		const out = await handleEpicCommand('/fake', ['last'], 'sess-1');
		expect(out).toContain('phantom dep ids');
		expect(out).toContain('2.99');
		expect(out).toContain('missing upstreams');
		expect(out).toContain('1.1');
	});

	test('passing gate with cross-phase upstreams in git ⇒ renderer names them', async () => {
		_internals.readPromotionEvidence = (() => [
			{
				timestamp: '2026-06-03T14:00:00Z',
				sessionID: 'sess-1',
				phase: 2,
				verdict: {
					decision: 'promote' as const,
					p: 0.05,
					rationale: {
						pCheck: { passed: true, p: 0.05, threshold: 0.3 },
						hotModuleCheck: { passed: true, touchedHotModules: [] },
						greenfieldCheck: {
							passed: true,
							commitsObserved: 3,
							minCommits: 20,
							crossPhaseUpstreams: ['1.1', '1.2'],
							missingUpstreams: [],
						},
					},
					blockingReasons: [],
				},
			},
		]) as never;

		const out = await handleEpicCommand('/fake', ['last'], 'sess-1');
		expect(out).toContain('cross-phase upstreams in git: 1.1, 1.2');
	});

	test('passing gate with no cross-phase upstreams ⇒ renders "vacuous" (Phase 1 / single-phase plans)', async () => {
		_internals.readPromotionEvidence = (() => [
			{
				timestamp: '2026-06-03T15:00:00Z',
				sessionID: 'sess-1',
				phase: 1,
				verdict: {
					decision: 'promote' as const,
					p: 0.05,
					rationale: {
						pCheck: { passed: true, p: 0.05, threshold: 0.3 },
						hotModuleCheck: { passed: true, touchedHotModules: [] },
						greenfieldCheck: {
							passed: true,
							commitsObserved: 0,
							minCommits: 20,
							crossPhaseUpstreams: [],
							missingUpstreams: [],
						},
					},
					blockingReasons: [],
				},
			},
		]) as never;

		const out = await handleEpicCommand('/fake', ['last'], 'sess-1');
		expect(out).toContain('vacuous');
	});

	test('legacy record with no diagnostic fields ⇒ renderer prints honest "(legacy record?)" hint', async () => {
		_internals.readPromotionEvidence = (() => [
			{
				timestamp: '2026-05-01T10:00:00Z',
				sessionID: 'sess-pre10',
				phase: 1,
				verdict: {
					decision: 'demote' as const,
					p: 0.5,
					rationale: {
						pCheck: { passed: false, p: 0.5, threshold: 0.3 },
						hotModuleCheck: { passed: true, touchedHotModules: [] },
						greenfieldCheck: {
							passed: false,
							commitsObserved: 0,
							minCommits: 20,
							// no crossPhaseUpstreams / missingUpstreams /
							// phantomDeps — legacy pre-Phase-10 record
						},
					},
					blockingReasons: ['pre-Phase-10 reason'],
				},
			},
		]) as never;

		const out = await handleEpicCommand('/fake', ['last'], 'sess-1');
		// Renderer doesn't crash. Doesn't print misleading empty list.
		expect(out).toContain('legacy record');
	});
});
