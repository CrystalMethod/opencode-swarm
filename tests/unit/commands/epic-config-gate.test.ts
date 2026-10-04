/**
 * `/swarm epic` — config master gates and v2 declared-scope resolution.
 *
 *  - `on` refuses with EPIC_MODE_CONFIG_DISABLED_MESSAGE unless
 *    `turbo.epic.mode.enabled === true` (config load failure fails closed).
 *  - `off`, `status`, `last`, `calibration`, `decide` keep working with the
 *    mode gate off — a user can always inspect or turn Epic Mode off.
 *  - `decide` fetches co-change data only when
 *    `turbo.epic.cochange.enabled === true` and renders the signal state.
 *  - `decide` resolves declared scopes from real `declare_scope` bindings.
 *
 * Uses the `_internals` DI seam (AGENTS.md invariant 7).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals, handleEpicCommand } from '../../../src/commands/epic';
import { EPIC_MODE_CONFIG_DISABLED_MESSAGE } from '../../../src/turbo/epic/config-gate';
import type { CouplingTask } from '../../../src/turbo/epic/coupling-report';
import {
	declareScopesForTest,
	resetDeclaredScopesForTest,
} from '../../helpers/declared-scope-bindings';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const realInternals = { ..._internals };
let config: Record<string, unknown>;
let enableCalls: number;
let disableCalls: number;
let cochangeFetches: number;
let sessionFlag: { id: string; epicModeActive?: boolean };

beforeEach(() => {
	config = {};
	enableCalls = 0;
	disableCalls = 0;
	cochangeFetches = 0;
	sessionFlag = { id: 'sess-1', epicModeActive: true };
	_internals.ensureAgentSession = (() => sessionFlag) as never;
	_internals.loadPluginConfigWithMeta = (() => ({ config })) as never;
	_internals.isStateUnreadable = (() => false) as never;
	_internals.loadEpicSessionState = (() => null) as never;
	_internals.enableEpicMode = (() => {
		enableCalls += 1;
	}) as never;
	_internals.disableEpicMode = (() => {
		disableCalls += 1;
	}) as never;
	_internals.getCoChangeData = (async () => {
		cochangeFetches += 1;
		return { pairs: [], commitsObserved: 7 };
	}) as never;
	_internals.isGitRepo = (() => false) as never;
	_internals.readPromotionEvidence = (() => []) as never;
	_internals.isCalibrationStateUnreadable = (() => false) as never;
	_internals.loadCalibrationState = (() => null) as never;
});

afterEach(async () => {
	Object.assign(_internals, realInternals);
	await resetDeclaredScopesForTest();
});

describe('/swarm epic on — turbo.epic.mode.enabled gate', () => {
	test('refuses when mode.enabled is absent', async () => {
		const out = await handleEpicCommand('/fake', ['on'], 'sess-1');
		expect(out).toBe(EPIC_MODE_CONFIG_DISABLED_MESSAGE);
		expect(enableCalls).toBe(0);
	});

	test('refuses when mode.enabled is false', async () => {
		config = { turbo: { epic: { mode: { enabled: false } } } };
		const out = await handleEpicCommand('/fake', ['on'], 'sess-1');
		expect(out).toBe(EPIC_MODE_CONFIG_DISABLED_MESSAGE);
		expect(enableCalls).toBe(0);
	});

	test('refuses (fails closed) when config cannot be loaded', async () => {
		_internals.loadPluginConfigWithMeta = (() => {
			throw new Error('bad config');
		}) as never;
		const out = await handleEpicCommand('/fake', ['on'], 'sess-1');
		expect(out).toBe(EPIC_MODE_CONFIG_DISABLED_MESSAGE);
		expect(enableCalls).toBe(0);
	});

	test('enables when mode.enabled is true', async () => {
		config = { turbo: { epic: { mode: { enabled: true } } } };
		const out = await handleEpicCommand('/fake', ['on'], 'sess-1');
		expect(out).toContain('Epic Mode enabled');
		expect(enableCalls).toBe(1);
	});
});

describe('/swarm epic — other subcommands work with the mode gate off', () => {
	test('`off` always works', async () => {
		const out = await handleEpicCommand('/fake', ['off'], 'sess-1');
		expect(out).toBe('Epic Mode disabled for this session.');
		expect(disableCalls).toBe(1);
		expect(sessionFlag.epicModeActive).toBe(false);
	});

	test('status / last / calibration render without the opt-in', async () => {
		for (const sub of [[], ['status'], ['last'], ['calibration']]) {
			const out = await handleEpicCommand('/fake', sub, 'sess-1');
			expect(out).not.toContain(EPIC_MODE_CONFIG_DISABLED_MESSAGE);
			expect(out).toContain('Epic Mode');
		}
	});
});

describe('/swarm epic decide — co-change gate and v2 declared scopes', () => {
	let dir: string;
	let cleanup: () => void;
	let capturedTasks: CouplingTask[];

	beforeEach(() => {
		const created = createSafeTestDir('epic-cmd-decide-');
		dir = created.dir;
		cleanup = created.cleanup;
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		const task = (id: string) => ({
			id,
			phase: 1,
			status: 'pending',
			size: 'small',
			description: `Task ${id}`,
			depends: [],
			files_touched: [],
			acceptance: 'Done',
		});
		fs.writeFileSync(
			path.join(dir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Epic cmd decide',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'P1',
						status: 'in_progress',
						tasks: [task('1.1'), task('1.2')],
					},
				],
			}),
		);
		capturedTasks = [];
		const real = realInternals.decideEpicActivation;
		_internals.decideEpicActivation = ((
			tasks: CouplingTask[],
			...rest: [never, never, never]
		) => {
			capturedTasks = tasks;
			return real(tasks, ...rest);
		}) as never;
	});

	afterEach(() => {
		cleanup();
	});

	test('co-change disabled: not fetched, rendered as disabled by config', async () => {
		const out = await handleEpicCommand(dir, ['decide'], 'sess-1');
		expect(cochangeFetches).toBe(0);
		expect(out).toContain('co-change signal: disabled by config');
	});

	test('co-change enabled: fetched and rendered as enabled', async () => {
		config = { turbo: { epic: { cochange: { enabled: true } } } };
		const out = await handleEpicCommand(dir, ['decide'], 'sess-1');
		expect(cochangeFetches).toBe(1);
		expect(out).toContain('co-change signal: enabled');
	});

	test('declared scopes come from real declare_scope bindings, not v1 files', async () => {
		const scopesDir = path.join(dir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });
		fs.writeFileSync(
			path.join(scopesDir, 'scope-1.2.json'),
			JSON.stringify({ taskId: '1.2', files: ['src/stale.ts'] }),
		);
		await declareScopesForTest(dir, { '1.1': ['src/a.ts'] });

		await handleEpicCommand(dir, ['decide'], 'sess-1');

		const byId = Object.fromEntries(capturedTasks.map((t) => [t.id, t.scope]));
		expect(byId['1.1']).toEqual(['src/a.ts']);
		// v1 file ignored; falls back to (empty) files_touched.
		expect(byId['1.2']).toEqual([]);
	});
});
