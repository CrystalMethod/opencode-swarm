/**
 * Epic v2 C2 wave close (`src/turbo/epic/wave-close.ts`):
 *   - outcome fields from evidence (generation, Stage A/B lower bounds) and
 *     the plan ledger (resolution time, reopen count);
 *   - divergence sources: write attribution unioned across same-project
 *     sessions (coder CHILD sessions), never another project's; the git
 *     fallback (real repository) for a single-task wave, and wave-level
 *     undeclared files otherwise;
 *   - `applyWaveClose` is idempotent (a concurrent close wins once);
 *   - calibration is fed from the close (divergence record + hot module).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../../src/config/plan-schema';
import { loadCalibrationState } from '../../../../src/turbo/epic/calibration';
import { readDivergenceHistory } from '../../../../src/turbo/epic/divergence-recorder';
import type { EpicWaveRecord } from '../../../../src/turbo/epic/lifecycle';
import {
	_internals,
	applyWaveClose,
	computeWaveClose,
	feedEpicCalibration,
	releaseWaveAttribution,
} from '../../../../src/turbo/epic/wave-close';
import { stubEpicRecord } from '../../../helpers/epic-lifecycle';
import { freezeClock, type Restore } from '../../../helpers/test-clock';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';
import { phasePlan } from './next-wave-fixture';
import { git } from './start-fixture';

const realInternals = { ..._internals };
const NOW = '2026-08-04T10:00:00.000Z';
let dir: string;
let restoreClock: Restore | null = null;

function wave(overrides: Partial<EpicWaveRecord> = {}): EpicWaveRecord {
	return {
		seq: 1,
		phase: 1,
		kind: 'parallel',
		taskIds: ['1.1', '1.2'],
		files: { '1.1': ['src/a.ts'], '1.2': ['src/b.ts'] },
		cochange: null,
		baseHead: null,
		issuedAt: NOW,
		status: 'issued',
		...overrides,
	};
}

function plan(statuses: Record<string, 'completed' | 'closed'>): Plan {
	return phasePlan([
		Object.entries(statuses).map(([id, status]) => ({ id, status })),
	]);
}

function session(project: string, files: Record<string, string[]>) {
	return {
		owningProjectKey: project,
		modifiedFilesByTask: new Map(Object.entries(files)),
	};
}

beforeEach(() => {
	restoreClock = freezeClock({ isoNow: NOW });
	dir = canonicalMkdtemp('epic-wave-close-');
	_internals.readLedgerEvents = (async () => []) as never;
	_internals.readTaskEvidence = (async () => null) as never;
	_internals.listAgentSessions = () => [];
	_internals.getAgentSession = (() => undefined) as never;
	_internals.hydrationProjectKey = () => 'project-key';
});

afterEach(() => {
	Object.assign(_internals, realInternals);
	restoreClock?.();
	restoreClock = null;
	fs.rmSync(dir, { recursive: true, force: true });
});

const noGitEpic = () =>
	stubEpicRecord({
		git: {
			isRepo: false,
			baseCommit: null,
			originalBranch: null,
			epicBranch: null,
		},
		startedAt: '2026-08-01T00:00:00.000Z',
	});

describe('outcome fields', () => {
	test('evidence workflow counts, ledger times and reopen count', async () => {
		_internals.readTaskEvidence = (async (_d: string, id: string) =>
			id === '1.1'
				? {
						workflow: {
							generation: 3,
							retryHistory: [
								'stage_a_failed',
								'stage_b_failed',
								'stage_b_failed',
							],
						},
					}
				: null) as never;
		_internals.readLedgerEvents = (async () => [
			{
				task_id: '1.1',
				event_type: 'task_status_changed',
				from_status: 'pending',
				to_status: 'completed',
				timestamp: '2026-08-02T00:00:00.000Z',
			},
			{
				task_id: '1.1',
				event_type: 'task_status_changed',
				from_status: 'completed',
				to_status: 'in_progress',
				timestamp: '2026-08-02T01:00:00.000Z',
			},
			{
				task_id: '1.1',
				event_type: 'task_status_changed',
				from_status: 'completed',
				to_status: 'pending',
				timestamp: '2026-07-01T00:00:00.000Z',
			},
			{
				task_id: '1.1',
				event_type: 'task_status_changed',
				from_status: 'in_progress',
				to_status: 'completed',
				timestamp: '2026-08-02T02:00:00.000Z',
			},
			{
				task_id: '1.2',
				event_type: 'task_status_changed',
				from_status: 'pending',
				to_status: 'closed',
				timestamp: '2026-08-02T03:00:00.000Z',
			},
		]) as never;
		const result = await computeWaveClose({
			directory: dir,
			epic: noGitEpic(),
			wave: wave(),
			plan: plan({ '1.1': 'completed', '1.2': 'closed' }),
			sessionID: undefined,
			nowIso: NOW,
		});
		expect(result.closeHead).toBeNull();
		expect(result.outcomes[0]).toMatchObject({
			taskId: '1.1',
			resolution: 'completed',
			resolvedAt: '2026-08-02T02:00:00.000Z',
			generation: 3,
			stageAFailures: 1,
			stageBFailures: 2,
			// The July reopen predates the epic start.
			reopened: 1,
			attribution: 'no-git',
			marker: { ref: null, sha: null, provenance: 'no-git' },
		});
		expect(result.outcomes[1]).toMatchObject({
			taskId: '1.2',
			resolution: 'closed',
			resolvedAt: '2026-08-02T03:00:00.000Z',
			generation: 0,
		});
		expect(result.divergence).toEqual([]);
	});

	test('a task missing from the plan resolves as removed', async () => {
		const result = await computeWaveClose({
			directory: dir,
			epic: noGitEpic(),
			wave: wave(),
			plan: plan({ '1.1': 'completed' }),
			sessionID: undefined,
			nowIso: NOW,
		});
		expect(result.outcomes[1]).toMatchObject({
			taskId: '1.2',
			resolution: 'removed',
			resolvedAt: NOW,
		});
	});
});

describe('divergence: session attribution', () => {
	test('child-session attribution of the same project counts; another project never does', async () => {
		const child = session('project-key', {
			'1.1': ['src/a.ts', 'src/extra.ts'],
		});
		const foreign = session('other-project', { '1.1': ['src/foreign.ts'] });
		const caller = session('project-key', { '1.2': ['src/b.ts'] });
		_internals.getAgentSession = (() => caller) as never;
		_internals.listAgentSessions = () =>
			[
				['ses_child', child],
				['ses_foreign', foreign],
				['ses_caller', caller],
			] as never;
		const result = await computeWaveClose({
			directory: dir,
			epic: noGitEpic(),
			wave: wave(),
			plan: plan({ '1.1': 'completed', '1.2': 'completed' }),
			sessionID: 'ses_caller',
			nowIso: NOW,
		});
		expect(result.outcomes[0]).toMatchObject({
			undeclared: ['src/extra.ts'],
			attribution: 'session',
		});
		expect(result.outcomes[1]).toMatchObject({
			undeclared: [],
			attribution: 'session',
		});
		expect(result.divergence).toEqual([
			{
				taskId: '1.1',
				declared: ['src/a.ts'],
				actual: ['src/a.ts', 'src/extra.ts'],
			},
			{ taskId: '1.2', declared: ['src/b.ts'], actual: ['src/b.ts'] },
		]);
	});
});

describe('divergence: git fallback (real repository)', () => {
	let base: string;
	beforeEach(() => {
		git(dir, ['init', '-q']);
		git(dir, ['config', 'user.email', 't@example.com']);
		git(dir, ['config', 'user.name', 'T']);
		git(dir, ['config', 'commit.gpgsign', 'false']);
		fs.writeFileSync(path.join(dir, '.gitignore'), '.swarm/\n');
		git(dir, ['add', '.']);
		git(dir, ['commit', '-q', '-m', 'seed']);
		base = git(dir, ['rev-parse', 'HEAD']).trim();
		fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'a\n');
		git(dir, ['add', 'src/a.ts']);
		git(dir, ['commit', '-q', '-m', 'swarm(task 1.1): a']);
		fs.writeFileSync(path.join(dir, 'src', 'stray.ts'), 'stray\n');
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(dir, '.swarm', 'x.json'), '{}');
	});

	const gitEpic = () =>
		stubEpicRecord({ startedAt: '2026-08-01T00:00:00.000Z' });

	test('single-task wave: changed files since baseHead are the task’s actual files', async () => {
		const result = await computeWaveClose({
			directory: dir,
			epic: gitEpic(),
			wave: wave({
				taskIds: ['1.1'],
				files: { '1.1': ['src/a.ts'] },
				baseHead: base,
			}),
			plan: plan({ '1.1': 'completed' }),
			sessionID: undefined,
			nowIso: NOW,
		});
		const head = git(dir, ['rev-parse', 'HEAD']).trim();
		expect(result.closeHead).toBe(head);
		expect(result.outcomes[0]).toMatchObject({
			undeclared: ['src/stray.ts'],
			attribution: 'git-single-task',
			marker: {
				ref: 'refs/swarm/epics/test-swarm-Test_Plan-0123456789ab/tasks/1.1',
				sha: head,
				provenance: 'wave-close-head',
			},
		});
		expect(result.waveUndeclared).toEqual(['src/stray.ts']);
	});

	test('multi-task wave without attribution: undeclared kept at wave level only', async () => {
		const result = await computeWaveClose({
			directory: dir,
			epic: gitEpic(),
			wave: wave({ baseHead: base }),
			plan: plan({ '1.1': 'completed', '1.2': 'completed' }),
			sessionID: undefined,
			nowIso: NOW,
		});
		expect(result.outcomes.map((o) => o.attribution)).toEqual([
			'unavailable',
			'unavailable',
		]);
		expect(result.divergence).toEqual([]);
		expect(result.waveUndeclared).toEqual(['src/stray.ts']);
	});
});

describe('applyWaveClose', () => {
	test('closes once; a second application is a no-op (concurrent close)', () => {
		const record = stubEpicRecord({ waves: [wave()], activeWaveSeq: 1 });
		const computation = {
			closeHead: null,
			outcomes: [],
			waveUndeclared: ['src/x.ts'],
			divergence: [],
		};
		const closed = applyWaveClose(record, 1, computation, NOW);
		expect(closed).not.toBe(record);
		expect(closed.activeWaveSeq).toBeNull();
		expect(closed.waves[0]).toMatchObject({
			status: 'closed',
			closedAt: NOW,
			undeclared: ['src/x.ts'],
		});
		expect(applyWaveClose(closed, 1, computation, NOW)).toBe(closed);
	});
});

describe('feedEpicCalibration', () => {
	const epicConfig = (enabled: boolean) =>
		({
			turbo: {
				strategy: 'standard',
				epic: { mode: { enabled: true }, calibration: { enabled } },
			},
		}) as never;
	const divergence = [
		{
			taskId: '1.1',
			declared: ['src/a.ts'],
			actual: ['src/a.ts', 'src/hot.ts'],
		},
	];

	test('records divergence and learns the undeclared file as a hot module', () => {
		feedEpicCalibration({
			directory: dir,
			config: epicConfig(true),
			plan: plan({ '1.1': 'completed' }),
			wave: wave(),
			divergence,
			sessionID: 'ses_x',
		});
		const history = readDivergenceHistory(dir);
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			taskId: '1.1',
			undeclared: ['src/hot.ts'],
			phaseNumber: 1,
		});
		const state = loadCalibrationState(dir);
		expect(state?.hotModuleAdditions).toEqual(['src/hot.ts']);
		expect(state?.processedRecords).toBe(1);
	});

	test('calibration disabled: divergence is still recorded, the engine does not run', () => {
		feedEpicCalibration({
			directory: dir,
			config: epicConfig(false),
			plan: plan({ '1.1': 'completed' }),
			wave: wave(),
			divergence,
			sessionID: undefined,
		});
		expect(readDivergenceHistory(dir)).toHaveLength(1);
		expect(
			fs.existsSync(path.join(dir, '.swarm', 'epic', 'calibration.json')),
		).toBe(false);
	});
});

describe('releaseWaveAttribution', () => {
	test('releases the closed tasks in every same-project session, never another project', () => {
		const caller = session('project-key', { '1.1': ['src/a.ts'] });
		const child = session('project-key', {
			'1.1': ['src/a.ts'],
			'9.9': ['src/keep.ts'],
		});
		const foreign = session('other-project', { '1.1': ['src/x.ts'] });
		_internals.getAgentSession = (() => caller) as never;
		_internals.listAgentSessions = () =>
			[
				['ses_caller', caller],
				['ses_child', child],
				['ses_foreign', foreign],
			] as never;
		releaseWaveAttribution(dir, 'ses_caller', ['1.1']);
		expect(caller.modifiedFilesByTask.has('1.1')).toBe(false);
		expect(child.modifiedFilesByTask.has('1.1')).toBe(false);
		expect(child.modifiedFilesByTask.get('9.9')).toEqual(['src/keep.ts']);
		expect(foreign.modifiedFilesByTask.get('1.1')).toEqual(['src/x.ts']);
	});
});
