/**
 * `/swarm epic` — config master gates and v2 declared-scope resolution.
 *
 *  - `start` renders the start refusal `epic-disabled-by-config` as
 *    EPIC_MODE_CONFIG_DISABLED_MESSAGE (the gate itself is tested in
 *    tests/unit/turbo/epic/start-refusals.test.ts).
 *  - `close`, `status`, `last`, `calibration`, `decide` keep working with the
 *    mode gate off — a user can always inspect or close an epic.
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
let cochangeFetches: number;

beforeEach(() => {
	config = {};
	cochangeFetches = 0;
	_internals.loadPluginConfigWithMeta = (() => ({ config })) as never;
	_internals.retireLegacyEpicSessionState = (() => ({
		rowsRemoved: 0,
		activeSessions: 0,
		fileArchivedTo: null,
		errors: [],
	})) as never;
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

describe('/swarm epic start — config gate refusal rendering', () => {
	test('epic-disabled-by-config renders the remediation message', async () => {
		_internals.startEpic = (async () => ({
			status: 'refused',
			reason: 'epic-disabled-by-config',
			details: [EPIC_MODE_CONFIG_DISABLED_MESSAGE],
		})) as never;
		const out = await handleEpicCommand('/fake', ['start'], 'sess-1');
		expect(out).toBe(
			`Epic not started — **epic-disabled-by-config**.\n\n${EPIC_MODE_CONFIG_DISABLED_MESSAGE}`,
		);
	});
});

describe('/swarm epic — other subcommands work with the mode gate off', () => {
	test('`close` always works (no epic open)', async () => {
		_internals.closeEpic = (async () => ({
			status: 'no-epic',
			repairedSentinel: false,
		})) as never;
		const out = await handleEpicCommand('/fake', ['close'], 'sess-1');
		expect(out).toBe('No epic is open.');
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
