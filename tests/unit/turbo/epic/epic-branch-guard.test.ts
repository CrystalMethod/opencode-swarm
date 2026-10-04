/**
 * Epic v2 C1b — branch-drift guard (M-e). Under the epic-branch policy HEAD
 * must be the recorded epic branch:
 *   - `checkEpicBranch` (one `git rev-parse --abbrev-ref HEAD`) returns a
 *     structured EPIC_BRANCH_MISMATCH with the `git checkout` remedy, and
 *     fails closed on an unrecorded branch or a git failure;
 *   - `epic_decide_phase` / `epic_plan_waves` refuse with
 *     `epic-branch-mismatch`;
 *   - Rule 2 writes its marker on the epic branch, and skips it (fail
 *     closed) when HEAD is on any other branch.
 * Real git repositories, epics opened by the production `startEpic`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { handleEpicCommand } from '../../../../src/commands/epic';
import { closeAllProjectDbs } from '../../../../src/db/project-db';
import { updateTaskStatus } from '../../../../src/plan/manager';
import { executeEpicPlanWaves } from '../../../../src/tools/epic-plan-waves';
import { executeEpicDecidePhase } from '../../../../src/tools/epic-run-phase';
import {
	_internals as branchInternals,
	checkEpicBranch,
	describeEpicBranchMismatchForProject,
} from '../../../../src/turbo/epic/epic-branch';
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

describe('Epic tools refuse on branch drift', () => {
	test('epic_decide_phase ⇒ epic-branch-mismatch', async () => {
		git(epic.dir, ['checkout', '-q', epic.originalBranch]);
		const result = await executeEpicDecidePhase({
			directory: epic.dir,
			phase: 1,
			sessionID: 'ses_branch',
		});
		expect(result).toMatchObject({
			success: false,
			reason: 'epic-branch-mismatch',
		});
		expect(result.message).toContain(`git checkout ${epic.epicBranch}`);
	});

	test('epic_plan_waves ⇒ epic-branch-mismatch; back on the branch it plans', async () => {
		git(epic.dir, ['checkout', '-q', epic.originalBranch]);
		const refused = await executeEpicPlanWaves({
			directory: epic.dir,
			phase: 1,
		});
		expect(refused).toMatchObject({
			success: false,
			reason: 'epic-branch-mismatch',
		});
		expect(refused.errors?.[0]).toContain('EPIC_BRANCH_MISMATCH');
		git(epic.dir, ['checkout', '-q', epic.epicBranch]);
		const planned = await executeEpicPlanWaves({
			directory: epic.dir,
			phase: 1,
		});
		expect(planned.success).toBe(true);
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
