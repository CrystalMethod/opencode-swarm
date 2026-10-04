/**
 * epic_decide_phase × Epic v2 lifecycle: the open epic comes from the
 * sentinel-first lifecycle probe (`getOpenEpic`), an unreadable lifecycle row
 * fails closed, and the framework-supplied session id (not a model-supplied
 * argument) is the one recorded in the decision evidence.
 *
 * Split from epic-run-phase.test.ts (FR-006 cap). `_internals` DI only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	epic_decide_phase,
	executeEpicDecidePhase,
} from '../../../src/tools/epic-run-phase';
import { stubEpicRecord } from '../../helpers/epic-lifecycle';

const realInternals = { ..._internals };
const stub = { evidenceAppends: 0 };

beforeEach(() => {
	stub.evidenceAppends = 0;
	_internals.getOpenEpic = (() => stubEpicRecord()) as never;
	_internals.loadPluginConfigWithMeta = (() => ({
		config: {
			turbo: { strategy: 'standard', epic: { mode: { enabled: true } } },
		},
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
	_internals.resolveEpicDeclaredScopes = ((
		_d: string,
		_p: unknown,
		ids: string[],
	) => Object.fromEntries(ids.map((id) => [id, []]))) as never;
	_internals.isGitRepo = (() => false) as never;
	_internals.loadCalibrationState = (() => null) as never;
	_internals.getCoChangeData = (async () => ({
		pairs: [],
		commitsObserved: 0,
	})) as never;
	_internals.decideEpicActivation = (() => ({
		decision: 'promote',
		p: 0,
		rationale: {
			pCheck: { passed: true, p: 0, threshold: 0.3 },
			hotModuleCheck: { passed: true, touchedHotModules: [] },
			greenfieldCheck: { passed: true, commitsObserved: 0, minCommits: 20 },
		},
		blockingReasons: [],
	})) as never;
	_internals.appendPromotionEvidence = (() => {
		stub.evidenceAppends += 1;
		return '/fake/evidence/path';
	}) as never;
	_internals.recordEpicLastDecision = (() => {}) as never;
});

afterEach(() => {
	Object.assign(_internals, realInternals);
});

describe('executeEpicDecidePhase — lifecycle state', () => {
	test('returns epic-state-unreadable when the lifecycle row is corrupt', async () => {
		_internals.getOpenEpic = (() => {
			throw new Error('Epic lifecycle row is not valid JSON');
		}) as never;
		const result = await executeEpicDecidePhase({
			directory: '/fake',
			phase: 1,
			sessionID: 's1',
		});
		expect(result.success).toBe(false);
		expect(result.reason).toBe('epic-state-unreadable');
		expect(result.errors).toEqual(['Epic lifecycle row is not valid JSON']);
		expect(result.message).toContain('/swarm epic close --abandon');
		expect(stub.evidenceAppends).toBe(0);
	});
});

describe('epic_decide_phase tool — ctx.sessionID precedence (Fix B)', () => {
	test('uses ctx.sessionID over args.sessionID when the framework supplies it', async () => {
		// Reproduce the live failure: weaker models hallucinate
		// sessionID="default" in args, while the framework supplies the
		// real session via ctx. The tool must prefer ctx.
		let observedSessionID: string | undefined;
		_internals.appendPromotionEvidence = ((
			_dir: string,
			record: { sessionID: string },
		) => {
			observedSessionID = record.sessionID;
			return '/fake/evidence/path';
		}) as never;

		const def = epic_decide_phase as unknown as {
			execute: (
				args: unknown,
				ctx?: { sessionID?: string; directory?: string },
			) => Promise<unknown>;
		};
		await def.execute(
			{ phase: 1, sessionID: 'ses_defaultArg' },
			{ sessionID: 'ses_realCtxAbc123', directory: '/fake' },
		);
		expect(observedSessionID).toBe('ses_realCtxAbc123');
	});

	test('falls back to args.sessionID when ctx is missing', async () => {
		let observedSessionID: string | undefined;
		_internals.appendPromotionEvidence = ((
			_dir: string,
			record: { sessionID: string },
		) => {
			observedSessionID = record.sessionID;
			return '/fake/evidence/path';
		}) as never;

		const def = epic_decide_phase as unknown as {
			execute: (
				args: unknown,
				ctx?: { sessionID?: string; directory?: string },
			) => Promise<unknown>;
		};
		// ctx with no sessionID — must use args.sessionID.
		await def.execute(
			{ phase: 1, sessionID: 'ses_fromArgs' },
			{ directory: '/fake' },
		);
		expect(observedSessionID).toBe('ses_fromArgs');
	});
});
