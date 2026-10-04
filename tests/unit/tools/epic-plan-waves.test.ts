/**
 * Tests for the `epic_plan_waves` tool wrapper.
 *
 * Covers the tool boundary: preflight branches (epic-disabled-by-config,
 * no-plan, no-phase, phase-empty, phase-already-complete, scopes-missing,
 * git-failed, planner-error) and the success path that forwards to
 * `planEpicWaves`. Declared scopes go through the real `declare_scope`
 * (v2 bindings); hand-written v1 scope files appear only in the regression
 * proving they are ignored.
 *
 * All tests use the `_internals` DI seam (AGENTS.md invariant 7) — no
 * `mock.module`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	executeEpicPlanWaves,
} from '../../../src/tools/epic-plan-waves';
import { EPIC_MODE_CONFIG_DISABLED_MESSAGE } from '../../../src/turbo/epic/config-gate';
import {
	declareScopesForTest,
	resetDeclaredScopesForTest,
} from '../../helpers/declared-scope-bindings';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';

// Capture original internals so each test restores after override.
const originals = { ..._internals };

// Epic Mode is opt-in (`turbo.epic.mode.enabled`); enable it for every test
// except the explicit config-gate cases, which override this stub.
const enableEpicConfig = () =>
	({ config: { turbo: { epic: { mode: { enabled: true } } } } }) as never;

beforeEach(() => {
	_internals.loadPluginConfigWithMeta = enableEpicConfig;
});

afterEach(async () => {
	Object.assign(_internals, originals);
	await resetDeclaredScopesForTest();
});

/** Schema-valid plan (required for real `declare_scope`). */
function schemaPlan(
	phaseId: number,
	tasks: Array<{ id: string; depends?: string[]; files_touched?: string[] }>,
) {
	return {
		schema_version: '1.0.0',
		title: 'Epic plan waves tool',
		swarm: 'test-swarm',
		current_phase: phaseId,
		phases: [
			{
				id: phaseId,
				name: `Phase ${phaseId}`,
				status: 'in_progress',
				tasks: tasks.map((t) => ({
					id: t.id,
					phase: phaseId,
					status: 'pending',
					size: 'small',
					description: `Task ${t.id}`,
					depends: t.depends ?? [],
					files_touched: t.files_touched ?? [],
					acceptance: 'Done',
				})),
			},
		],
	};
}

/**
 * Envelope invariant: on any failure (`success: false`), the success-only
 * aliases MUST be undefined. Otherwise a downstream caller doing
 * `result.waves?.length ?? 0` could mask a real failure as "empty phase".
 */
function expectCleanFailureEnvelope(result: {
	success: boolean;
	plan?: unknown;
	waves?: unknown;
	serializedTasks?: unknown;
	degradedTasks?: unknown;
}): void {
	expect(result.success).toBe(false);
	expect(result.plan).toBeUndefined();
	expect(result.waves).toBeUndefined();
	expect(result.serializedTasks).toBeUndefined();
	expect(result.degradedTasks).toBeUndefined();
}

/** Frozen instant for the stale-v1 regression (see `writeStaleV1Scope`). */
const V1_FROZEN_NOW_MS = Date.parse('2026-06-01T12:00:00.000Z');

/**
 * Hand-written legacy v1 scope file stamped as declared "just now" against the
 * frozen clock, so no TTL/expiry can explain it being ignored — only the
 * v2-only resolution can. Call inside `withFrozenClockAsync`.
 */
function writeStaleV1Scope(dir: string, taskId: string, files: string[]) {
	fs.writeFileSync(
		path.join(dir, '.swarm', 'scopes', `scope-${taskId}.json`),
		JSON.stringify({
			taskId,
			files,
			declaredAt: new Date(Date.now()).toISOString(),
		}),
	);
}

describe('executeEpicPlanWaves — preflight branches', () => {
	let tempDir: string;
	let scopesDir: string;
	let swarmDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-plan-waves-tool-'));
		swarmDir = path.join(tempDir, '.swarm');
		scopesDir = path.join(swarmDir, 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });
		// Non-git project by default — Rule 1 bypass, no git predicate.
		_internals.isGitRepo = () => false;
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	test('epic-disabled-by-config: mode.enabled !== true refuses before any planning', async () => {
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify(schemaPlan(1, [{ id: '1.1', files_touched: ['a.ts'] }])),
		);
		for (const stub of [
			() => ({ config: {} }) as never,
			() =>
				({
					config: { turbo: { epic: { mode: { enabled: false } } } },
				}) as never,
			() => {
				throw new Error('config unreadable');
			},
		]) {
			_internals.loadPluginConfigWithMeta = stub;
			const result = await executeEpicPlanWaves({
				directory: tempDir,
				phase: 1,
			});
			expect(result.reason).toBe('epic-disabled-by-config');
			expect(result.errors).toEqual([EPIC_MODE_CONFIG_DISABLED_MESSAGE]);
			expectCleanFailureEnvelope(result);
		}
	});

	test('REGRESSION: stale v1 scope files do not satisfy the preflight', async () => {
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify(schemaPlan(1, [{ id: '1.1' }, { id: '1.2' }])),
		);
		await withFrozenClockAsync(
			async () => {
				writeStaleV1Scope(tempDir, '1.1', ['src/a.ts']);
				writeStaleV1Scope(tempDir, '1.2', ['src/b.ts']);
				const result = await executeEpicPlanWaves({
					directory: tempDir,
					phase: 1,
				});
				expect(result.reason).toBe('scopes-missing');
				expect(result.missingScopes?.sort()).toEqual(['1.1', '1.2']);
				expect(result.errors?.[0]).toContain('expired (bindings live 1h)');
				expect(result.errors?.[0]).toContain(
					'plan was revised since declaration',
				);
				expect(result.errors?.[0]).toContain('`scopes` map');
			},
			{ fixedNow: V1_FROZEN_NOW_MS },
		);
	});

	test('no-plan: missing plan.json returns reason="no-plan"', async () => {
		const result = await executeEpicPlanWaves({ directory: tempDir, phase: 1 });
		expect(result.reason).toBe('no-plan');
		expectCleanFailureEnvelope(result);
	});

	test('no-plan: malformed plan.json with non-array `phases` returns reason="no-plan" (no crash)', async () => {
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({ phases: 'not an array' }),
		);
		const result = await executeEpicPlanWaves({ directory: tempDir, phase: 1 });
		expect(result.reason).toBe('no-plan');
		expect(result.errors?.[0]).toContain('`phases` is not an array');
		expectCleanFailureEnvelope(result);
	});

	test('phase-empty: phase.tasks is null returns reason="phase-empty" (no crash on .length)', async () => {
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [{ id: 1, name: 'P', tasks: null }],
			}),
		);
		const result = await executeEpicPlanWaves({ directory: tempDir, phase: 1 });
		expect(result.reason).toBe('phase-empty');
		expectCleanFailureEnvelope(result);
	});

	test('phase-empty: phase.tasks is a string returns reason="phase-empty" (no crash on .filter)', async () => {
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [{ id: 1, name: 'P', tasks: 'not an array' }],
			}),
		);
		const result = await executeEpicPlanWaves({ directory: tempDir, phase: 1 });
		expect(result.reason).toBe('phase-empty');
		expectCleanFailureEnvelope(result);
	});

	test('no-phase: requested phase not in plan returns reason="no-phase"', async () => {
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 't', status: 'pending' }],
					},
				],
			}),
		);
		const result = await executeEpicPlanWaves({
			directory: tempDir,
			phase: 99,
		});
		expect(result.reason).toBe('no-phase');
		expect(result.errors?.[0]).toContain('Available phases');
		expectCleanFailureEnvelope(result);
	});

	test('phase-empty: phase with zero tasks returns reason="phase-empty"', async () => {
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [{ id: 1, name: 'Empty', tasks: [] }],
			}),
		);
		const result = await executeEpicPlanWaves({ directory: tempDir, phase: 1 });
		expect(result.reason).toBe('phase-empty');
		expectCleanFailureEnvelope(result);
	});

	test('phase-already-complete: all tasks completed returns reason="phase-already-complete"', async () => {
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{
						id: 1,
						name: 'Done',
						tasks: [
							{ id: '1.1', description: 't', status: 'completed' },
							{ id: '1.2', description: 't', status: 'completed' },
						],
					},
				],
			}),
		);
		const result = await executeEpicPlanWaves({ directory: tempDir, phase: 1 });
		expect(result.reason).toBe('phase-already-complete');
		expectCleanFailureEnvelope(result);
	});

	test('scopes-missing: pending task with no scope returns reason="scopes-missing" + missingScopes', async () => {
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [
							{
								id: '1.1',
								description: 't',
								status: 'pending',
								files_touched: [],
							},
							{
								id: '1.2',
								description: 't',
								status: 'pending',
								files_touched: [],
							},
						],
					},
				],
			}),
		);
		const result = await executeEpicPlanWaves({ directory: tempDir, phase: 1 });
		expect(result.reason).toBe('scopes-missing');
		expect(result.missingScopes?.sort()).toEqual(['1.1', '1.2']);
		expect(result.errors?.[0]).toContain('declare_scope');
		expectCleanFailureEnvelope(result);
	});

	test('scopes-missing: provided scopes argument satisfies preflight', async () => {
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [
							{
								id: '1.1',
								description: 't',
								status: 'pending',
								files_touched: [],
							},
						],
					},
				],
			}),
		);
		const result = await executeEpicPlanWaves({
			directory: tempDir,
			phase: 1,
			scopes: { '1.1': ['src/a.ts'] },
		});
		expect(result.success).toBe(true);
		expect(result.waves?.length).toBe(1);
	});

	test('scopes-missing: files_touched in plan satisfies preflight', async () => {
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [
							{
								id: '1.1',
								description: 't',
								status: 'pending',
								files_touched: ['src/a.ts'],
							},
						],
					},
				],
			}),
		);
		const result = await executeEpicPlanWaves({ directory: tempDir, phase: 1 });
		expect(result.success).toBe(true);
	});

	test('git-failed: gitFailed predicate returns reason="git-failed"', async () => {
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [{ id: '1.1', description: 't', status: 'pending' }],
					},
				],
			}),
		);
		_internals.isGitRepo = () => true;
		_internals.buildIsUpstreamCommittedWithStatus = () => ({
			predicate: () => false,
			gitFailed: true,
		});
		const result = await executeEpicPlanWaves({
			directory: tempDir,
			phase: 1,
			scopes: { '1.1': ['src/a.ts'] },
		});
		expect(result.reason).toBe('git-failed');
		expect(result.errors?.[0]).toContain('git log');
		expectCleanFailureEnvelope(result);
	});

	test('planner-error: readPlanJson throws downstream → reason="planner-error"', async () => {
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [{ id: '1.1', description: 't', status: 'pending' }],
					},
				],
			}),
		);
		// Sabotage the v2 declared-scope resolver to throw inside the planner
		_internals.resolveEpicDeclaredScopes = () => {
			throw new Error('synthetic disk read failure');
		};
		const result = await executeEpicPlanWaves({ directory: tempDir, phase: 1 });
		expect(result.reason).toBe('planner-error');
		expect(result.errors?.[0]).toContain('synthetic disk read failure');
		expectCleanFailureEnvelope(result);
	});
});

describe('executeEpicPlanWaves — success path forwards to planEpicWaves', () => {
	let tempDir: string;
	let scopesDir: string;
	let swarmDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'epic-plan-waves-success-'),
		);
		swarmDir = path.join(tempDir, '.swarm');
		scopesDir = path.join(swarmDir, 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });
		_internals.isGitRepo = () => false;
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	test('Phase-2 shape DAG (real declare_scope) produces 3 waves through the tool', async () => {
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify(
				schemaPlan(2, [
					{ id: '2.1' },
					{ id: '2.2', depends: ['2.1'] },
					...['2.3', '2.4', '2.5', '2.6'].map((id) => ({
						id,
						depends: ['2.1', '2.2'],
					})),
				]),
			),
		);
		await declareScopesForTest(tempDir, {
			'2.1': ['src/registry.py'],
			'2.2': ['src/column_types.py'],
			'2.3': ['src/models/logistic.py'],
			'2.4': ['src/models/random_forest.py'],
			'2.5': ['src/models/xgboost.py'],
			'2.6': ['src/models/mlp.py'],
		});
		const result = await executeEpicPlanWaves({ directory: tempDir, phase: 2 });
		expect(result.success).toBe(true);
		expect(result.waves?.length).toBe(3);
		expect(result.waves?.[0].taskIds).toEqual(['2.1']);
		expect(result.waves?.[1].taskIds).toEqual(['2.2']);
		expect(result.waves?.[2].taskIds).toEqual(['2.3', '2.4', '2.5', '2.6']);
		expect(result.plan?.totalConcurrentTasks).toBe(6);
	});

	test('three disjoint real declarations (no files_touched) → one concurrent wave', async () => {
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify(
				schemaPlan(1, [{ id: '1.1' }, { id: '1.2' }, { id: '1.3' }]),
			),
		);
		await declareScopesForTest(tempDir, {
			'1.1': ['src/a.ts'],
			'1.2': ['src/b.ts'],
			'1.3': ['src/c.ts'],
		});
		const result = await executeEpicPlanWaves({ directory: tempDir, phase: 1 });
		expect(result.success).toBe(true);
		expect(result.serializedTasks).toEqual([]);
		expect(result.waves?.map((w) => w.taskIds)).toEqual([
			['1.1', '1.2', '1.3'],
		]);
	});
});
