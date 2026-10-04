/**
 * `epic_next_wave` — git-side rules (Epic v2 C2), through the `_internals`
 * seam (no real repository needed):
 *   - predecessor evidence: a completed out-of-batch dependency counts only
 *     with a current-plan completion marker; a missing marker blocks
 *     `predecessor-missing`, a failed read blocks `git-failed`;
 *   - a dirty working tree blocks `dirty-baseline` before a wave is issued;
 *   - the issued wave records HEAD as `baseHead`;
 *   - with the co-change signal enabled, co-changing tasks are kept apart
 *     and the in-wave pairs are frozen into the record.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { markEpicPhaseComplete } from '../../../../src/turbo/epic/lifecycle';
import {
	_internals,
	runEpicNextWave,
} from '../../../../src/turbo/epic/next-wave';
import { freezeClock, type Restore } from '../../../helpers/test-clock';
import { type NextWaveProject, openNextWaveProject } from './next-wave-fixture';

const SESSION = 'ses_git';
const HEAD = 'a'.repeat(40);
let project: NextWaveProject;
let restoreClock: Restore | null = null;
let markerReads = 0;

const GIT_OVERRIDES = {
	config: {
		commitPolicy: 'current-branch' as const,
		isolation: 'worktree' as const,
		maxParallel: 4,
	},
	git: {
		isRepo: true,
		baseCommit: HEAD,
		originalBranch: 'main',
		epicBranch: null,
	},
};

async function open(
	config?: Record<string, unknown>,
	phases = [
		[
			{ id: '1.1', status: 'completed' as const },
			{ id: '1.2', depends: ['1.1'] },
			{ id: '1.3' },
		],
	],
): Promise<void> {
	project = await openNextWaveProject(phases, {
		config,
		overrides: GIT_OVERRIDES,
	});
	project.declareAll();
	_internals.checkEpicBranch = (() => ({ ok: true })) as never;
	_internals.listDirtyPathsOutsideSwarm = () => [];
	_internals.readHead = () => HEAD;
	_internals.resolvePlanMarkerScope = (async () => ({
		planKey: 'k'.repeat(16),
		rootTimestampMs: 0,
	})) as never;
	markerReads = 0;
	_internals.readPlanScopedCommittedTaskIds = (() => {
		markerReads += 1;
		return new Set(['1.1']);
	}) as never;
}

beforeEach(() => {
	restoreClock = freezeClock({ isoNow: '2026-08-03T10:00:00.000Z' });
});

afterEach(() => {
	project.cleanup();
	restoreClock?.();
	restoreClock = null;
});

describe('predecessor evidence (plan-scoped markers)', () => {
	test('a committed predecessor admits its dependent; baseHead is recorded', async () => {
		await open();
		const result = await runEpicNextWave(project.dir, SESSION);
		expect(result).toMatchObject({
			status: 'dispatch',
			wave: { taskIds: ['1.2', '1.3'] },
		});
		expect(markerReads).toBe(1);
		expect(project.record().waves[0]?.baseHead).toBe(HEAD);
	});

	test('a predecessor completed DURING the epic without a marker blocks predecessor-missing (not-committed)', async () => {
		await open();
		_internals.readPlanScopedCommittedTaskIds = (() => new Set()) as never;
		_internals.readLedgerEvents = (async () => [
			{
				event_type: 'task_status_changed',
				task_id: '1.1',
				from_status: 'in_progress',
				to_status: 'completed',
				timestamp: '2026-08-03T09:00:00.000Z',
			},
		]) as never;
		const result = await runEpicNextWave(project.dir, SESSION);
		expect(result).toMatchObject({
			status: 'blocked',
			reason: 'predecessor-missing',
			details: {
				problems: [{ taskId: '1.2', dependency: '1.1', why: 'not-committed' }],
			},
		});
		if (result.status === 'blocked') {
			expect(result.message).toContain(
				`git commit --allow-empty -m "swarm(task <id>): <description>" -m "Swarm-Plan: ${'0123456789abcdef'}"`,
			);
		}
		expect(project.record().waves).toEqual([]);
	});

	test('a predecessor completed BEFORE the epic started needs no marker', async () => {
		// 1.1 was saved completed with the plan (no ledger transition): its
		// work is in HEAD because start refused a dirty tree.
		await open(undefined, [
			[{ id: '1.1', status: 'completed' }],
			[{ id: '2.1', depends: ['1.1'] }],
		]);
		_internals.readPlanScopedCommittedTaskIds = (() => new Set()) as never;
		expect(markEpicPhaseComplete(project.dir, 1).outcome).toBe('recorded');
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { phase: 2, taskIds: ['2.1'] },
		});
	});

	test('a failing marker read blocks git-failed (fail closed)', async () => {
		await open();
		_internals.readPlanScopedCommittedTaskIds = (() => {
			throw new Error('index.lock exists');
		}) as never;
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'blocked',
			reason: 'git-failed',
			details: { error: 'index.lock exists' },
		});
	});

	test('no out-of-batch completed dependency ⇒ no marker read at all', async () => {
		await open(undefined, [[{ id: '1.1' }, { id: '1.2' }]]);
		expect((await runEpicNextWave(project.dir, SESSION)).status).toBe(
			'dispatch',
		);
		expect(markerReads).toBe(0);
	});
});

describe('dirty baseline', () => {
	test('uncommitted changes outside .swarm block before a wave is issued', async () => {
		await open();
		_internals.listDirtyPathsOutsideSwarm = () => ['src/stray.ts'];
		const result = await runEpicNextWave(project.dir, SESSION);
		expect(result).toMatchObject({
			status: 'blocked',
			reason: 'dirty-baseline',
			details: { files: ['src/stray.ts'], total: 1 },
		});
		expect(project.record().waves).toEqual([]);
		_internals.listDirtyPathsOutsideSwarm = () => {
			throw new Error('git status timed out');
		};
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'blocked',
			reason: 'git-failed',
		});
	});
});

describe('co-change signal', () => {
	const COCHANGE_ON = {
		turbo: {
			strategy: 'standard',
			epic: {
				mode: { enabled: true },
				cochange: { enabled: true, threshold: 0.5, min_co_changes: 2 },
			},
		},
	};

	test('enabled: co-changing tasks are kept apart and in-wave pairs are frozen', async () => {
		await open(COCHANGE_ON, [[{ id: '1.1' }, { id: '1.2' }, { id: '1.3' }]]);
		_internals.getCoChangeData = (async () => ({
			pairs: [
				{
					fileA: 'src/t1_1.ts',
					fileB: 'src/t1_2.ts',
					npmi: 0.9,
					coChangeCount: 4,
				},
				{
					fileA: 'src/t1_1.ts',
					fileB: 'src/t1_3.ts',
					npmi: 0.1,
					coChangeCount: 4,
				},
			],
			commitsObserved: 30,
		})) as never;
		const result = await runEpicNextWave(project.dir, SESSION);
		expect(result).toMatchObject({
			status: 'dispatch',
			wave: { taskIds: ['1.1', '1.3'] },
		});
		expect(project.record().waves[0]?.cochange).toEqual({
			pairs: [],
			threshold: { npmi: 0.5, minCoChanges: 2 },
		});
	});

	test('disabled (default): co-change data is never fetched; path-only', async () => {
		await open(undefined, [[{ id: '1.1' }, { id: '1.2' }]]);
		let fetched = 0;
		_internals.getCoChangeData = (async () => {
			fetched += 1;
			return { pairs: [], commitsObserved: 0 };
		}) as never;
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { taskIds: ['1.1', '1.2'] },
		});
		expect(fetched).toBe(0);
		expect(project.record().waves[0]?.cochange).toBeNull();
	});
});
