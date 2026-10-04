/**
 * Epic v2 C0 (B1) — the Rule 2 guard in `updateTaskStatus` consults the
 * merge-failure registry through the plan-epoch filter and hands the plan's
 * marker scope to `commitTaskCompletion`.
 *
 *  - a failure recorded BEFORE the plan root (a previous plan's same task id)
 *    no longer suppresses Rule 2;
 *  - a failure with NO timestamp still suppresses it (fail closed);
 *  - an unresolvable plan identity writes no marker and treats every
 *    failure as relevant.
 *
 * The clock is frozen while the plan is saved so the ledger root timestamp
 * is a known literal. Seams: manager `_internals` + merge-epoch `_internals`
 * (AGENTS.md #7), all restored in `afterEach`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import type { WorktreeMergeFailure } from '../../../src/hooks/delegation-gate/worktree-merge-status';
import {
	_internals,
	savePlan,
	updateTaskStatus,
} from '../../../src/plan/manager';
import { _internals as mergeEpoch } from '../../../src/turbo/epic/merge-epoch';
import type { PlanMarkerScope } from '../../../src/turbo/epic/plan-key';
import { freezeClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const ROOT_ISO = '2026-01-01T00:00:00.000Z';
const ROOT_MS = 1_767_225_600_000;

function makePlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Rule 2 Plan Epoch',
		swarm: 'test-swarm',
		current_phase: 1,
		migration_status: 'native',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'in_progress',
						size: 'small',
						description: 'epoch task',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

const orig = { ..._internals };
const origMerge = { ...mergeEpoch };
let dir: string;
let commits: Array<{ taskId: string; scope: PlanMarkerScope }>;
let failure: WorktreeMergeFailure | undefined;

beforeEach(async () => {
	dir = canonicalMkdtemp('c0-rule2-epoch-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	const restore = freezeClock({ fixedNow: ROOT_MS, isoNow: ROOT_ISO });
	try {
		await savePlan(dir, makePlan());
	} finally {
		restore();
	}
	commits = [];
	failure = undefined;
	_internals.isGitRepo = () => true;
	_internals.isEpicModeActiveForProject = () => true;
	_internals.maybeSaveAutoCheckpoint = async () => ({
		shouldSave: false,
		completedCount: 0,
		threshold: 0,
		skipReason: 'disabled',
		saved: false,
	});
	_internals.commitTaskCompletion = async (_d, taskId, _desc, _s, scope) => {
		commits.push({ taskId, scope });
		return { committed: true, reason: 'success' };
	};
	mergeEpoch.getWorktreeMergeFailure = () => failure;
});

afterEach(() => {
	Object.assign(_internals, orig);
	Object.assign(mergeEpoch, origMerge);
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('Rule 2 guard — plan-epoch merge-failure filter', () => {
	test('marker scope carries the plan key and the ledger root timestamp', async () => {
		await updateTaskStatus(dir, '1.1', 'completed');
		expect(commits).toHaveLength(1);
		expect(commits[0].scope.rootTimestampMs).toBe(ROOT_MS);
		expect(commits[0].scope.planKey).toMatch(/^[0-9a-f]{16}$/);
	});

	test('a stale failure recorded before the plan root does NOT suppress Rule 2', async () => {
		failure = {
			outcome: 'failed',
			stage: 'merge',
			message: 'previous plan',
			completedAt: ROOT_MS - 1,
		};
		await updateTaskStatus(dir, '1.1', 'completed');
		expect(commits.map((c) => c.taskId)).toEqual(['1.1']);
	});

	test('a failure recorded during the current plan suppresses Rule 2', async () => {
		failure = {
			outcome: 'partial',
			stage: 'rebase',
			message: 'this plan',
			queuedAt: ROOT_MS + 1,
		};
		await updateTaskStatus(dir, '1.1', 'completed');
		expect(commits).toEqual([]);
	});

	test('a failure with NO timestamp suppresses Rule 2 (fail closed)', async () => {
		failure = { outcome: 'failed', stage: 'merge', message: 'undated' };
		const updated = await updateTaskStatus(dir, '1.1', 'completed');
		expect(commits).toEqual([]);
		expect(updated.phases[0].tasks[0].status).toBe('completed');
	});

	test('unresolvable plan identity: no marker, every failure relevant', async () => {
		_internals.resolvePlanMarkerScope = async () => {
			throw new Error('Conflicting plan epoch metadata');
		};
		let sinceSeen: number | undefined;
		_internals.relevantMergeFailure = (_id, sinceMs) => {
			sinceSeen = sinceMs;
			return undefined;
		};
		await updateTaskStatus(dir, '1.1', 'completed');
		expect(sinceSeen).toBe(0);
		expect(commits).toEqual([]);
	});
});
