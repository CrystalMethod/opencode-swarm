/**
 * `selectNextEpicWave` (Epic v2 C2) — the pure next-wave choice over the
 * Epic wave planner: first concurrent wave, exclusive tasks alone, learned
 * hot modules, the width cap, declare-scopes, and every predecessor problem.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../../../src/config/constants';
import {
	cochangePairsWithin,
	type EpicWaveSelectionInput,
	selectNextEpicWave,
} from '../../../../src/turbo/epic/wave-select';
import { phasePlan, type TaskSpec } from './next-wave-fixture';

function input(
	phases: TaskSpec[][],
	overrides: Partial<EpicWaveSelectionInput> = {},
): EpicWaveSelectionInput {
	const plan = phasePlan(phases);
	const liveScopes: Record<string, string[]> = {};
	for (const phase of plan.phases) {
		for (const task of phase.tasks) liveScopes[task.id] = task.files_touched;
	}
	return {
		directory: '/project',
		plan,
		phaseId: 1,
		liveScopes,
		maxParallel: 4,
		leanConfig: { ...DEFAULT_LEAN_TURBO_CONFIG },
		isCommitted: () => true,
		hotModules: [],
		cochange: null,
		...overrides,
	};
}

describe('waves', () => {
	test('the first planner wave: disjoint ready tasks, frozen live scopes', () => {
		const result = selectNextEpicWave(
			input([[{ id: '1.1' }, { id: '1.2' }, { id: '1.3', depends: ['1.1'] }]]),
		);
		expect(result).toEqual({
			kind: 'wave',
			waveKind: 'parallel',
			taskIds: ['1.1', '1.2'],
			files: { '1.1': ['src/t1_1.ts'], '1.2': ['src/t1_2.ts'] },
			cochangePairs: [],
		});
	});

	test('path conflicts and the width cap defer tasks to a later wave', () => {
		const result = selectNextEpicWave(
			input(
				[
					[
						{ id: '1.1', files: ['src/shared.ts'] },
						{ id: '1.2', files: ['src/shared.ts'] },
						{ id: '1.3' },
						{ id: '1.4' },
					],
				],
				{ maxParallel: 2 },
			),
		);
		expect(result).toMatchObject({ kind: 'wave', taskIds: ['1.1', '1.3'] });
	});

	test('a global-file task runs alone first (exclusive)', () => {
		const result = selectNextEpicWave(
			input([[{ id: '1.1' }, { id: '1.2', files: ['package.json'] }]]),
		);
		expect(result).toMatchObject({
			kind: 'wave',
			waveKind: 'exclusive',
			taskIds: ['1.2'],
		});
	});

	test('learned hot modules: a hot task is deferred while others run, then runs alone', () => {
		const hot = { hotModules: ['src/t1_2.ts'] };
		expect(
			selectNextEpicWave(input([[{ id: '1.1' }, { id: '1.2' }]], hot)),
		).toMatchObject({ waveKind: 'parallel', taskIds: ['1.1'] });
		expect(
			selectNextEpicWave(
				input([[{ id: '1.1', status: 'completed' }, { id: '1.2' }]], hot),
			),
		).toMatchObject({ waveKind: 'exclusive', taskIds: ['1.2'] });
	});

	test('nothing left ⇒ none; only blocked tasks ⇒ task-blocked', () => {
		expect(
			selectNextEpicWave(input([[{ id: '1.1', status: 'completed' }]])),
		).toEqual({ kind: 'none' });
		expect(
			selectNextEpicWave(
				input([
					[
						{ id: '1.1', status: 'blocked' },
						{ id: '1.2', depends: ['1.1'] },
					],
				]),
			),
		).toEqual({ kind: 'task-blocked', taskIds: ['1.1'] });
	});
});

describe('declare-scopes', () => {
	test('chosen members without a live binding are reported with files_touched', () => {
		const base = input([[{ id: '1.1' }, { id: '1.2' }]]);
		const result = selectNextEpicWave({
			...base,
			liveScopes: { '1.1': ['src/t1_1.ts'], '1.2': [] },
		});
		expect(result).toEqual({
			kind: 'declare-scopes',
			tasks: [{ taskId: '1.2', suggestedFiles: ['src/t1_2.ts'] }],
		});
	});
});

describe('predecessor-missing', () => {
	test.each([
		['closed', [{ id: '1.0', status: 'closed' as const }]],
		['removed', []],
	])('a dependency that is %s', (why, extra) => {
		const result = selectNextEpicWave(
			input([[...extra, { id: '1.1', depends: ['1.0'] }, { id: '1.2' }]]),
		);
		expect(result).toEqual({
			kind: 'predecessor-missing',
			problems: [{ taskId: '1.1', dependency: '1.0', why }],
		});
	});

	test('a completed dependency without evidence is not-committed', () => {
		const result = selectNextEpicWave(
			input(
				[
					[
						{ id: '1.0', status: 'completed' },
						{ id: '1.1', depends: ['1.0'] },
					],
				],
				{
					isCommitted: () => false,
				},
			),
		);
		expect(result).toMatchObject({
			kind: 'predecessor-missing',
			problems: [{ why: 'not-committed' }],
		});
	});

	test('a dependency in a later phase', () => {
		const result = selectNextEpicWave(
			input([[{ id: '1.1', depends: ['2.1'] }], [{ id: '2.1' }]]),
		);
		expect(result).toMatchObject({
			kind: 'predecessor-missing',
			problems: [{ taskId: '1.1', dependency: '2.1', why: 'later-phase' }],
		});
	});

	test('a dependency cycle', () => {
		const result = selectNextEpicWave(
			input([
				[
					{ id: '1.1', depends: ['1.2'] },
					{ id: '1.2', depends: ['1.1'] },
				],
			]),
		);
		expect(result).toEqual({
			kind: 'predecessor-missing',
			problems: [
				{ taskId: '1.1', dependency: '1.2', why: 'cycle' },
				{ taskId: '1.2', dependency: '1.1', why: 'cycle' },
			],
		});
	});
});

describe('cochangePairsWithin', () => {
	test('keeps threshold-passing pairs within the files, strongest first, capped', () => {
		const pairs = Array.from({ length: 300 }, (_, i) => ({
			fileA: `src/a${i}.ts`,
			fileB: 'src/b.ts',
			npmi: i / 300,
			coChangeCount: 5,
		}));
		const files = [...pairs.map((p) => p.fileA), 'src/b.ts'];
		const within = cochangePairsWithin(files, {
			pairs: [
				...pairs,
				{
					fileA: 'src/a1.ts',
					fileB: 'src/outside.ts',
					npmi: 1,
					coChangeCount: 9,
				},
			] as never,
			threshold: { npmi: 0, minCoChanges: 5 },
		});
		expect(within).toHaveLength(256);
		expect(within[0]).toEqual({
			fileA: 'src/a299.ts',
			fileB: 'src/b.ts',
			npmi: 299 / 300,
			coChangeCount: 5,
		});
		expect(within.some((p) => p.fileB === 'src/outside.ts')).toBe(false);
	});
});
