/**
 * Epic v2 C1b — branch-drift guard (M-e). Under the epic-branch policy HEAD
 * must be the recorded epic branch:
 *   - `checkEpicBranch` (one `git rev-parse --abbrev-ref HEAD`) returns a
 *     structured EPIC_BRANCH_MISMATCH with the `git checkout` remedy, and
 *     fails closed on an unrecorded branch or a git failure;
 *   - `epic_next_wave` blocks with `epic-branch-mismatch` (and issues no
 *     wave);
 *   - Rule 2 writes its marker on the epic branch, and skips it (fail
 *     closed) when HEAD is on any other branch.
 * Real git repositories, epics opened by the production `startEpic`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { handleEpicCommand } from '../../../../src/commands/epic';
import { closeAllProjectDbs } from '../../../../src/db/project-db';
import { updateTaskStatus } from '../../../../src/plan/manager';
import {
	_internals as branchInternals,
	checkEpicBranch,
	describeEpicBranchMismatchForProject,
} from '../../../../src/turbo/epic/epic-branch';
import { getOpenEpic } from '../../../../src/turbo/epic/lifecycle';
import { runEpicNextWave } from '../../../../src/turbo/epic/next-wave';
import { stubEpicRecord } from '../../../helpers/epic-lifecycle';
import { freezeClock, type Restore } from '../../../helpers/test-clock';
import {
	git,
	headSha,
	restoreStartInternals,
	type StartedEpic,
	startedGitEpic,
	stubStartGlobals,
} from './epic-branch-fixture';

const realBranchInternals = { ...branchInternals };
let epic: StartedEpic;
let restoreClock: Restore | null = null;

beforeEach(async () => {
	restoreClock = freezeClock({ isoNow: '2026-07-02T09:00:00.000Z' });
	stubStartGlobals();
	epic = await startedGitEpic('epic-branch-guard-');
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	restoreStartInternals();
	Object.assign(branchInternals, realBranchInternals);
	closeAllProjectDbs();
	fs.rmSync(epic.dir, { recursive: true, force: true });
});

describe('checkEpicBranch', () => {
	test('on the epic branch ⇒ ok', () => {
		expect(checkEpicBranch(epic.dir, epic.record)).toEqual({ ok: true });
		expect(describeEpicBranchMismatchForProject(epic.dir)).toBeNull();
	});

	test('another branch ⇒ EPIC_BRANCH_MISMATCH with the checkout remedy', () => {
		git(epic.dir, ['checkout', '-q', epic.originalBranch]);
		const check = checkEpicBranch(epic.dir, epic.record);
		expect(check).toMatchObject({
			ok: false,
			code: 'EPIC_BRANCH_MISMATCH',
			expected: epic.epicBranch,
			actual: epic.originalBranch,
		});
		if (!check.ok) {
			expect(check.message).toContain(`git checkout ${epic.epicBranch}`);
		}
		expect(describeEpicBranchMismatchForProject(epic.dir)).toContain(
			'EPIC_BRANCH_MISMATCH',
		);
	});

	test('/swarm epic status shows the branch and the drift', async () => {
		const onBranch = await handleEpicCommand(epic.dir, ['status'], 'ses_b');
		expect(onBranch).toContain(`epic branch \`${epic.epicBranch}\``);
		expect(onBranch).not.toContain('EPIC_BRANCH_MISMATCH');
		git(epic.dir, ['checkout', '-q', epic.originalBranch]);
		const drifted = await handleEpicCommand(epic.dir, ['status'], 'ses_b');
		expect(drifted).toContain('EPIC_BRANCH_MISMATCH');
		expect(drifted).toContain(`git checkout ${epic.epicBranch}`);
	});

	test('detached HEAD ⇒ mismatch (actual null)', () => {
		git(epic.dir, ['checkout', '-q', '--detach']);
		const check = checkEpicBranch(epic.dir, epic.record);
		expect(check).toMatchObject({ ok: false, actual: null });
		if (!check.ok) expect(check.message).toContain('HEAD is detached');
	});

	test('git failure / unrecorded branch fail closed; current-branch and non-git pass', () => {
		branchInternals.gitExec = () => {
			throw new Error('simulated git timeout');
		};
		const failed = checkEpicBranch(epic.dir, epic.record);
		expect(failed).toMatchObject({ ok: false, code: 'EPIC_BRANCH_MISMATCH' });
		if (!failed.ok) expect(failed.message).toContain('simulated git timeout');
		const unrecorded = checkEpicBranch(epic.dir, {
			...epic.record,
			git: { ...epic.record.git, epicBranch: null },
		});
		expect(unrecorded).toMatchObject({ ok: false, expected: null });
		// No git call at all for these:
		expect(checkEpicBranch(epic.dir, stubEpicRecord())).toEqual({ ok: true });
		expect(
			checkEpicBranch(
				epic.dir,
				stubEpicRecord({
					config: {
						commitPolicy: 'epic-branch',
						isolation: 'main-tree-nogit',
						maxParallel: 1,
					},
					git: {
						isRepo: false,
						baseCommit: null,
						originalBranch: null,
						epicBranch: null,
					},
				}),
			),
		).toEqual({ ok: true });
	});

	test('unreadable epic ⇒ Rule 2 seam fails closed', () => {
		branchInternals.getOpenEpic = () => {
			throw new Error('multiple Epic lifecycle rows present');
		};
		expect(describeEpicBranchMismatchForProject(epic.dir)).toContain(
			'could not be read',
		);
	});
});

describe('epic_next_wave refuses on branch drift', () => {
	test('off the epic branch ⇒ blocked epic-branch-mismatch, no wave; back on it ⇒ proceeds', async () => {
		git(epic.dir, ['checkout', '-q', epic.originalBranch]);
		const refused = await runEpicNextWave(epic.dir, 'ses_branch');
		expect(refused).toMatchObject({
			status: 'blocked',
			reason: 'epic-branch-mismatch',
		});
		if (refused.status === 'blocked') {
			expect(refused.message).toContain(`git checkout ${epic.epicBranch}`);
		}
		expect(getOpenEpic(epic.dir)?.waves).toEqual([]);
		git(epic.dir, ['checkout', '-q', epic.epicBranch]);
		const next = await runEpicNextWave(epic.dir, 'ses_branch');
		expect(next.status).not.toBe('blocked');
		expect(next.status).not.toBe('refused');
	});
});

describe('Rule 2 and the epic branch', () => {
	test('the completion marker lands on the epic branch, not the original branch', async () => {
		const originalTip = headSha(epic.dir, epic.originalBranch);
		await updateTaskStatus(epic.dir, '1.1', 'completed');
		expect(
			git(epic.dir, ['log', '-1', '--format=%s', epic.epicBranch]).trim(),
		).toBe('swarm(task 1.1): task 1');
		expect(headSha(epic.dir, epic.originalBranch)).toBe(originalTip);
	});

	test('HEAD on another branch ⇒ marker skipped (fail closed); status still persisted', async () => {
		git(epic.dir, ['checkout', '-q', epic.originalBranch]);
		const originalTip = headSha(epic.dir, epic.originalBranch);
		const epicTip = headSha(epic.dir, epic.epicBranch);
		const updated = await updateTaskStatus(epic.dir, '1.2', 'completed');
		expect(
			updated.phases[0].tasks.find((task) => task.id === '1.2')?.status,
		).toBe('completed');
		expect(headSha(epic.dir, epic.originalBranch)).toBe(originalTip);
		expect(headSha(epic.dir, epic.epicBranch)).toBe(epicTip);
	});
});
