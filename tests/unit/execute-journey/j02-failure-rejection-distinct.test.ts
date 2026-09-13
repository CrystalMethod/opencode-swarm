/**
 * j02 — failure/rejection distinctness controls (AC2, issue #2666): a failed
 * provider call must NOT become a finished task; a reviewer or QA rejection
 * is a stage-b review failure (rework), structurally distinct from the
 * transport/settlement failure channel. All controls drive the REGISTERED
 * host surfaces (merged tool.execute hook chain + tool map).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import { resetSwarmState } from '../../../src/state';
import {
	bootJourneyHost,
	createJourneyProject,
	JourneyDriver,
	journeyPlanArgs,
	validateJourneyReport,
} from '../../helpers/execute-journey-driver';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';

const TASK_ID = '1.1';
const FILE = 'src/feature.ts';

/** Drive configure→…→EXECUTE up to coder_delegated through registered surfaces. */
async function driveThroughExecute(
	driver: JourneyDriver,
	directory: string,
	mutate: () => void,
): Promise<void> {
	await driver.configure();
	await driver.discover();
	await driver.specify(journeyPlanArgs({ taskId: TASK_ID, file: FILE }));
	await driver.approve('journey fixture j02: plan-critic approval');
	await driver.executeCoder({ taskId: TASK_ID, file: FILE, mutate });
}

describe('failure/rejection distinctness through the registered host (#2666)', () => {
	let project: ReturnType<typeof createJourneyProject> | null = null;
	let cleanupEnv: (() => void) | null = null;

	beforeEach(() => {
		cleanupEnv = createIsolatedTestEnv().cleanup;
		resetSwarmState();
	});
	afterEach(() => {
		resetSwarmState();
		cleanupEnv?.();
		cleanupEnv = null;
		project?.cleanup();
		project = null;
	});

	test('a provider-failed coder dispatch never finishes the task', async () => {
		project = createJourneyProject('swarm-j02a-');
		const booted = await bootJourneyHost({ directory: project.directory });
		const driver = new JourneyDriver(booted);
		await driveThroughExecute(driver, project.directory, () => {});
		// Re-dispatch the coder for the SAME task with a provider-class
		// failure output (transport channel).
		await driver.driveTaskDelegation({
			role: 'coder',
			callID: 'journey-coder-provider-fail',
			taskId: TASK_ID,
			file: FILE,
			mutate: () =>
				writeFileSync(
					path.join(project!.directory, FILE),
					'export const feature = 3;\n',
				),
			output: {
				state: 'error',
				error: new Error('provider: 503 service unavailable'),
			},
		});
		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(project.directory, TASK_ID),
		);
		// The task must NOT be finished: no completion, terminal refusal.
		expect(snapshot.state).not.toBe('complete');
		expect(snapshot.state).not.toBe('tests_run');
		// The failure stays in the SETTLEMENT channel (coder: transition
		// ids), never a gate verdict id.
		expect(snapshot.lastTransitionId).toMatch(/^coder:/);
		// No task_completed receipt exists at all.
		expect(snapshot.lastOutcome).not.toBe('task_completed');

		const report = driver.report({ command: 'bun test j02 provider-fail' });
		const validation = validateJourneyReport(report);
		expect(validation.unevidencedStages).toEqual([]);
	}, 120_000);

	test('a reviewer REJECTED verdict is a stage-b review failure, distinct from transport failure', async () => {
		project = createJourneyProject('swarm-j02b-');
		const booted = await bootJourneyHost({ directory: project.directory });
		const driver = new JourneyDriver(booted);
		await driveThroughExecute(driver, project.directory, () =>
			writeFileSync(
				path.join(project!.directory, FILE),
				'export const feature = 2;\n',
			),
		);
		await driver.preCheck({ taskId: TASK_ID, file: FILE });
		await driver.dispatchStageB({
			role: 'reviewer',
			taskId: TASK_ID,
			file: FILE,
			verdictLine: `[REVIEWED] | task-${TASK_ID} | REJECTED | findings require rework`,
		});
		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(project.directory, TASK_ID),
		);
		expect(snapshot.state).toBe('rework_required');
		expect(snapshot.lastOutcome).toBe('stage_b_failed');
		// Distinctness: the rejection lands in the GATE channel
		// (gate-failed: transition ids), never the settlement channel.
		expect(snapshot.lastTransitionId).toMatch(/^gate-failed:/);
		expect(snapshot.state).not.toBe('complete');
	}, 120_000);

	test('a QA (test_engineer) FAIL verdict after reviewer APPROVED stays a review failure, never complete', async () => {
		project = createJourneyProject('swarm-j02c-');
		const booted = await bootJourneyHost({ directory: project.directory });
		const driver = new JourneyDriver(booted);
		await driveThroughExecute(driver, project.directory, () =>
			writeFileSync(
				path.join(project!.directory, FILE),
				'export const feature = 2;\n',
			),
		);
		await driver.preCheck({ taskId: TASK_ID, file: FILE });
		await driver.dispatchStageB({
			role: 'reviewer',
			taskId: TASK_ID,
			file: FILE,
			verdictLine: `[REVIEWED] | task-${TASK_ID} | APPROVED | reviewed ${TASK_ID}`,
		});
		// QA rejection: test_engineer verdict vocabulary is PASS|FAIL|SKIPPED
		// (stage-b-gates.ts:95) — FAIL is the rejection form.
		await driver.dispatchStageB({
			role: 'test_engineer',
			taskId: TASK_ID,
			file: FILE,
			verdictLine: `[TESTED] | task-${TASK_ID} | FAIL | tests failed`,
		});
		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(project.directory, TASK_ID),
		);
		expect(snapshot.state).toBe('rework_required');
		expect(snapshot.lastOutcome).toBe('stage_b_failed');
		expect(snapshot.lastTransitionId).toMatch(/^gate-failed:/);
		expect(snapshot.state).not.toBe('complete');
		// The finish control must refuse: update_task_status on a rejected
		// task cannot complete it through the registered tool.
		const finish = await driver.finishTask({ taskId: TASK_ID });
		expect(finish.success).toBe(false);
	}, 120_000);

	test('completion is refused before Stage B runs (zero gate completions)', async () => {
		project = createJourneyProject('swarm-j02d-');
		const booted = await bootJourneyHost({ directory: project.directory });
		const driver = new JourneyDriver(booted);
		await driveThroughExecute(driver, project.directory, () =>
			writeFileSync(
				path.join(project!.directory, FILE),
				'export const feature = 2;\n',
			),
		);
		// The task sits at coder_delegated with ZERO Stage B completions
		// (pre_check_batch not yet run): the registered update_task_status
		// must refuse completion (production checkReviewerGate path).
		const finish = await driver.finishTask({ taskId: TASK_ID });
		expect(finish.success).toBe(false);
		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(project.directory, TASK_ID),
		);
		expect(snapshot.state).toBe('coder_delegated');
		expect(snapshot.lastOutcome).not.toBe('task_completed');
	}, 120_000);
});
