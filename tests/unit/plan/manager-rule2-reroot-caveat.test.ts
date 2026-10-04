/**
 * Epic v2 C0 — KNOWN CAVEAT pin (reviewer M2): re-rooting the plan ledger
 * (save_plan title/swarm rename, /swarm rollback, truncated-ledger recovery)
 * mints a new plan root and plan key. Until C1/C2 move Epic onto an
 * Epic-owned identity and wave timestamps:
 *
 *   - markers written before the re-root are orphaned (new planKey) — Rule 3
 *     fails closed for them (dependants serialize);
 *   - a merge failure recorded BEFORE the re-root is classified stale, so
 *     Rule 2 writes the marker anyway (fail OPEN).
 *
 * This test pins today's behavior so the C2 change that closes the fail-open
 * must flip it deliberately. Clock frozen per save so ledger roots are
 * literals; seams restored in `afterEach` (AGENTS.md #7).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	_internals,
	savePlan,
	updateTaskStatus,
} from '../../../src/plan/manager';
import { _internals as mergeEpoch } from '../../../src/turbo/epic/merge-epoch';
import type { PlanMarkerScope } from '../../../src/turbo/epic/plan-key';
import { freezeClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const T0_ISO = '2026-01-01T00:00:00.000Z';
const T0 = 1_767_225_600_000;
const T1 = T0 + 1_000; // merge failure recorded
const T2_ISO = '2026-01-01T00:00:02.000Z';
const T2 = T0 + 2_000; // re-root

function makePlan(title: string): Plan {
	return {
		schema_version: '1.0.0',
		title,
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
						description: 'reroot task',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

async function saveAt(dir: string, plan: Plan, ms: number, iso: string) {
	const restore = freezeClock({ fixedNow: ms, isoNow: iso });
	try {
		await savePlan(dir, plan);
	} finally {
		restore();
	}
}

const orig = { ..._internals };
const origMerge = { ...mergeEpoch };
let dir: string;
let commits: PlanMarkerScope[];

beforeEach(() => {
	dir = canonicalMkdtemp('c0-reroot-caveat-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	commits = [];
	_internals.isGitRepo = () => true;
	_internals.isEpicOpenForProject = () => true;
	_internals.maybeSaveAutoCheckpoint = async () => ({
		shouldSave: false,
		completedCount: 0,
		threshold: 0,
		skipReason: 'disabled',
		saved: false,
	});
	_internals.commitTaskCompletion = async (_d, _id, _desc, _s, scope) => {
		commits.push(scope);
		return { committed: true, reason: 'success' };
	};
	mergeEpoch.getWorktreeMergeFailure = () => ({
		outcome: 'failed',
		stage: 'merge',
		message: 'recorded before the re-root',
		completedAt: T1,
	});
});

afterEach(() => {
	Object.assign(_internals, orig);
	Object.assign(mergeEpoch, origMerge);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('CAVEAT (until C2): a title rename re-roots — prior markers orphaned, pre-re-root merge failure ignored (fail open)', async () => {
	const planA = makePlan('Reroot Plan');
	await saveAt(dir, planA, T0, T0_ISO);
	const before = await _internals.resolvePlanMarkerScope(dir, planA);
	expect(before.rootTimestampMs).toBe(T0);

	// Same work, renamed plan → savePlan re-roots the ledger at T2.
	await saveAt(dir, makePlan('Reroot Plan v2'), T2, T2_ISO);
	await updateTaskStatus(dir, '1.1', 'completed');

	expect(commits).toHaveLength(1);
	// New root and key: markers bound to `before.planKey` no longer count.
	expect(commits[0].rootTimestampMs).toBe(T2);
	expect(commits[0].planKey).not.toBe(before.planKey);
	// The unresolved failure (T1 < T2) was treated as stale: Rule 2 fired.
	// C2 must flip this expectation when wave timestamps supersede the root.
});
