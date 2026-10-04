/**
 * `epic_plan_waves` — declared scopes come ONLY from the v2 binding store.
 *
 * The tool resolves every pending task's live `declare_scope` binding via the
 * Epic resolver (`src/turbo/epic/declared-scopes.ts`) and passes the result as
 * the explicit `scopes` map to the shared partition preflight, so the
 * preflight's own legacy v1 `.swarm/scopes/scope-<id>.json` read is never
 * reached for an Epic task. Caller-supplied `scopes` entries win per task.
 * Declarations go through the real `declare_scope` path.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	executeEpicPlanWaves,
} from '../../../src/tools/epic-plan-waves';
import {
	declareScopesForTest,
	resetDeclaredScopesForTest,
} from '../../helpers/declared-scope-bindings';
import { wideOpenEpic } from '../../helpers/epic-lifecycle';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';

const originals = { ..._internals };
let dir: string;
let cleanup: () => void;

function writePlan(
	tasks: Array<{ id: string; files_touched?: string[] }>,
): void {
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Epic plan waves v2 scopes',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: tasks.map((t) => ({
						id: t.id,
						phase: 1,
						status: 'pending',
						size: 'small',
						description: `Task ${t.id}`,
						depends: [],
						files_touched: t.files_touched ?? [],
						acceptance: 'Done',
					})),
				},
			],
		}),
	);
}

/** Frozen instant for the stale-v1 regressions (see `writeStaleV1Scope`). */
const V1_FROZEN_NOW_MS = Date.parse('2026-06-01T12:00:00.000Z');

/**
 * Hand-written legacy v1 scope file stamped as declared "just now" against the
 * frozen clock, so no TTL/expiry can explain it being ignored — only the
 * v2-only resolution can. Call inside `withFrozenClockAsync`.
 */
function writeStaleV1Scope(taskId: string, files: string[]): void {
	const scopesDir = path.join(dir, '.swarm', 'scopes');
	fs.mkdirSync(scopesDir, { recursive: true });
	fs.writeFileSync(
		path.join(scopesDir, `scope-${taskId}.json`),
		JSON.stringify({
			taskId,
			files,
			declaredAt: new Date(Date.now()).toISOString(),
		}),
	);
}

function useLeanConfig(lean: Record<string, unknown>): void {
	_internals.loadPluginConfigWithMeta = (() => ({
		config: { turbo: { epic: { mode: { enabled: true } }, lean } },
	})) as never;
}

beforeEach(() => {
	_internals.getOpenEpic = wideOpenEpic; // an epic must be open
	const created = createSafeTestDir('epic-plan-waves-v2-');
	dir = created.dir;
	cleanup = created.cleanup;
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	_internals.isGitRepo = () => false;
	useLeanConfig({});
});

afterEach(async () => {
	Object.assign(_internals, originals);
	await resetDeclaredScopesForTest();
	cleanup();
});

describe('executeEpicPlanWaves — v2-only declared scopes', () => {
	test('REGRESSION: a stale v1 file never reaches the planner (require_declared_scope: true)', async () => {
		writePlan([
			{ id: '1.1' },
			{ id: '1.2' },
			// 1.3 passes the tool preflight via files_touched only; under
			// require_declared_scope it must be classified no-scope (serialized).
			// A planner that consulted the stale v1 file would instead treat it
			// as DECLARED ['src/a.ts'] and wave it after 1.1.
			{ id: '1.3', files_touched: ['src/c.ts'] },
		]);
		await withFrozenClockAsync(
			async () => {
				await declareScopesForTest(dir, {
					'1.1': ['src/a.ts'],
					'1.2': ['src/b.ts'],
				});
				writeStaleV1Scope('1.3', ['src/a.ts']);

				const result = await executeEpicPlanWaves({ directory: dir, phase: 1 });

				expect(result.success).toBe(true);
				expect(result.serializedTasks).toEqual(['1.3']);
				expect(result.waves?.map((w) => w.taskIds)).toEqual([['1.1', '1.2']]);
			},
			{ fixedNow: V1_FROZEN_NOW_MS },
		);
	});

	test('REGRESSION: with require_declared_scope: false the stale v1 file is ignored and files_touched applies', async () => {
		useLeanConfig({ require_declared_scope: false });
		writePlan([{ id: '1.1' }, { id: '1.3', files_touched: ['src/c.ts'] }]);
		await withFrozenClockAsync(
			async () => {
				await declareScopesForTest(dir, { '1.1': ['src/a.ts'] });
				// Conflicts with 1.1 — would split the wave if the planner read it.
				writeStaleV1Scope('1.3', ['src/a.ts']);

				const result = await executeEpicPlanWaves({ directory: dir, phase: 1 });

				expect(result.success).toBe(true);
				expect(result.serializedTasks).toEqual([]);
				expect(result.waves?.map((w) => w.taskIds)).toEqual([['1.1', '1.3']]);
			},
			{ fixedNow: V1_FROZEN_NOW_MS },
		);
	});

	test('caller-supplied scopes win over the live binding for the same task', async () => {
		writePlan([{ id: '1.1' }, { id: '1.2' }]);
		// Live bindings conflict on the same file…
		await declareScopesForTest(dir, {
			'1.1': ['src/a.ts'],
			'1.2': ['src/a.ts'],
		});
		const conflicting = await executeEpicPlanWaves({
			directory: dir,
			phase: 1,
		});
		expect(conflicting.waves?.map((w) => w.taskIds)).toEqual([
			['1.1'],
			['1.2'],
		]);

		// …but the caller's explicit entry for 1.2 overrides its binding.
		const overridden = await executeEpicPlanWaves({
			directory: dir,
			phase: 1,
			scopes: { '1.2': ['src/b.ts'] },
		});
		expect(overridden.success).toBe(true);
		expect(overridden.waves?.map((w) => w.taskIds)).toEqual([['1.1', '1.2']]);
	});

	test('a declaration made against an older plan revision is not live', async () => {
		writePlan([{ id: '1.1' }, { id: '1.2' }]);
		await declareScopesForTest(dir, {
			'1.1': ['src/a.ts'],
			'1.2': ['src/b.ts'],
		});
		// Revise the plan structure (new task) after declaring.
		writePlan([{ id: '1.1' }, { id: '1.2' }, { id: '1.3' }]);

		const result = await executeEpicPlanWaves({ directory: dir, phase: 1 });

		expect(result.reason).toBe('scopes-missing');
		expect(result.missingScopes?.sort()).toEqual(['1.1', '1.2', '1.3']);
	});
});
