/**
 * `epic_decide_phase` (executeEpicDecidePhase): config master gates and
 * declared-scope resolution from the authoritative v2 binding store.
 *
 *  - `turbo.epic.mode.enabled !== true` ⇒ `epic-disabled-by-config`
 *    (refused before any plan/scope/session work; config load failure fails
 *    closed).
 *  - `turbo.epic.cochange.enabled !== true` ⇒ the co-change signal is never
 *    fetched, `p` uses path-only conflicts, and the rationale records
 *    `cochangeSignal: 'disabled-by-config'` (distinct from "signal absent").
 *  - Scopes declared through the REAL `declare_scope` path satisfy the
 *    scopes-missing preflight; stale v1 `scope-<id>.json` files and
 *    declarations against an older plan revision do not.
 *
 * Only session/evidence side effects are stubbed through `_internals`
 * (AGENTS.md invariant 7); plan loading, scope resolution, and the
 * activation decision are real.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	executeEpicDecidePhase,
} from '../../../src/tools/epic-run-phase';
import type { EpicActivationOptions } from '../../../src/turbo/epic/activation';
import { EPIC_MODE_CONFIG_DISABLED_MESSAGE } from '../../../src/turbo/epic/config-gate';
import {
	declareScopesForTest,
	resetDeclaredScopesForTest,
} from '../../helpers/declared-scope-bindings';
import { stubEpicRecord } from '../../helpers/epic-lifecycle';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const realInternals = { ..._internals };
const SESSION = 'ses_epicdecidev2';
let dir: string;
let cleanup: () => void;
let config: Record<string, unknown>;
let cochangeFetches: number;
let isEpicActiveCalls: number;

function writePlan(description = 'Task 1.3'): void {
	const task = (id: string, desc: string) => ({
		id,
		phase: 1,
		status: 'pending',
		size: 'small',
		description: desc,
		depends: [],
		files_touched: [],
		acceptance: 'Done',
	});
	const plan = {
		schema_version: '1.0.0',
		title: 'Epic decide v2',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'P1',
				status: 'in_progress',
				tasks: [
					task('1.1', 'Task 1.1'),
					task('1.2', 'Task 1.2'),
					task('1.3', description),
				],
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

const DISJOINT = {
	'1.1': ['src/a.ts'],
	'1.2': ['src/b.ts'],
	'1.3': ['src/c.ts'],
};

beforeEach(() => {
	const created = createSafeTestDir('epic-decide-v2-');
	dir = created.dir;
	cleanup = created.cleanup;
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	config = { turbo: { epic: { mode: { enabled: true } } } };
	cochangeFetches = 0;
	isEpicActiveCalls = 0;
	_internals.loadPluginConfigWithMeta = (() => ({ config })) as never;
	_internals.getOpenEpic = (() => {
		isEpicActiveCalls += 1;
		return stubEpicRecord();
	}) as never;
	_internals.getCoChangeData = (async () => {
		cochangeFetches += 1;
		return { pairs: [], commitsObserved: 42 };
	}) as never;
	_internals.isGitRepo = (() => false) as never;
	_internals.appendPromotionEvidence = (() => '/fake') as never;
	_internals.recordEpicLastDecision = (() => {}) as never;
	_internals.loadCalibrationState = (() => null) as never;
});

afterEach(async () => {
	Object.assign(_internals, realInternals);
	await resetDeclaredScopesForTest();
	cleanup();
});

describe('epic_decide_phase — turbo.epic.mode.enabled master gate', () => {
	for (const [label, cfg] of [
		['absent', {}],
		['false', { turbo: { epic: { mode: { enabled: false } } } }],
	] as const) {
		test(`mode.enabled ${label} → epic-disabled-by-config`, async () => {
			writePlan();
			config = cfg as Record<string, unknown>;
			const result = await executeEpicDecidePhase({
				directory: dir,
				phase: 1,
				sessionID: SESSION,
			});
			expect(result.success).toBe(false);
			expect(result.reason).toBe('epic-disabled-by-config');
			expect(result.message).toBe(EPIC_MODE_CONFIG_DISABLED_MESSAGE);
			expect(isEpicActiveCalls).toBe(0);
		});
	}

	test('config load failure fails closed', async () => {
		_internals.loadPluginConfigWithMeta = (() => {
			throw new Error('unreadable config');
		}) as never;
		const result = await executeEpicDecidePhase({
			directory: dir,
			phase: 1,
			sessionID: SESSION,
		});
		expect(result.reason).toBe('epic-disabled-by-config');
	});
});

describe('epic_decide_phase — declared scopes from real declare_scope', () => {
	test('three disjoint real declarations (no files_touched) → decided, not scopes-missing', async () => {
		writePlan();
		await declareScopesForTest(dir, DISJOINT);
		const result = await executeEpicDecidePhase({
			directory: dir,
			phase: 1,
			sessionID: SESSION,
		});
		expect(result.reason).toBe('decided');
		expect(result.verdict?.decision).toBe('promote');
	});

	test('REGRESSION: stale v1 scope files alone → scopes-missing with the v2 remediation text', async () => {
		writePlan();
		const scopesDir = path.join(dir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });
		for (const [id, files] of Object.entries(DISJOINT)) {
			fs.writeFileSync(
				path.join(scopesDir, `scope-${id}.json`),
				JSON.stringify({ taskId: id, files }),
			);
		}
		const result = await executeEpicDecidePhase({
			directory: dir,
			phase: 1,
			sessionID: SESSION,
		});
		expect(result.reason).toBe('scopes-missing');
		expect(result.missingScopes?.sort()).toEqual(['1.1', '1.2', '1.3']);
		expect(result.message).toContain('expired (bindings live 1h)');
		expect(result.message).toContain('plan was revised since declaration');
		expect(result.message).toContain('re-run `declare_scope`');
	});

	test('declarations against an older plan revision → scopes-missing', async () => {
		writePlan();
		await declareScopesForTest(dir, DISJOINT);
		writePlan('Task 1.3 revised');
		const result = await executeEpicDecidePhase({
			directory: dir,
			phase: 1,
			sessionID: SESSION,
		});
		expect(result.reason).toBe('scopes-missing');
	});
});

describe('epic_decide_phase — turbo.epic.cochange.enabled gate', () => {
	function captureActivationOptions(): {
		get: () => { pairs: unknown[]; options: EpicActivationOptions } | null;
	} {
		let captured: { pairs: unknown[]; options: EpicActivationOptions } | null =
			null;
		const real = realInternals.decideEpicActivation;
		_internals.decideEpicActivation = ((
			tasks: Parameters<typeof real>[0],
			pairs: Parameters<typeof real>[1],
			commits: number,
			options: EpicActivationOptions,
		) => {
			captured = { pairs, options };
			return real(tasks, pairs, commits, options);
		}) as never;
		return { get: () => captured };
	}

	test('disabled (default): no co-change fetch, path-only p, rationale says disabled-by-config', async () => {
		writePlan();
		await declareScopesForTest(dir, DISJOINT);
		const capture = captureActivationOptions();
		const result = await executeEpicDecidePhase({
			directory: dir,
			phase: 1,
			sessionID: SESSION,
		});
		expect(result.reason).toBe('decided');
		expect(cochangeFetches).toBe(0);
		expect(capture.get()?.pairs).toEqual([]);
		expect(result.verdict?.rationale.pCheck.cochangeSignal).toBe(
			'disabled-by-config',
		);
	});

	test('enabled: co-change data is fetched and the rationale says enabled', async () => {
		writePlan();
		await declareScopesForTest(dir, DISJOINT);
		config = {
			turbo: { epic: { mode: { enabled: true }, cochange: { enabled: true } } },
		};
		const result = await executeEpicDecidePhase({
			directory: dir,
			phase: 1,
			sessionID: SESSION,
		});
		expect(result.reason).toBe('decided');
		expect(cochangeFetches).toBe(1);
		expect(result.verdict?.rationale.pCheck.cochangeSignal).toBe('enabled');
		expect(result.verdict?.rationale.greenfieldCheck.commitsObserved).toBe(42);
	});
});
