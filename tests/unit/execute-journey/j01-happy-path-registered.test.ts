/**
 * j01 — normal EXECUTE journey happy path through the REGISTERED host (AC1,
 * issue #2666). One booted real `server()` drives configure → discover →
 * specify → approve → EXECUTE (declare_scope + coder dispatch through the
 * merged tool.execute hook chain) → pre-check (Stage A) → reviewer → QA →
 * finish, asserting a DURABLE receipt at every gate plus the exact
 * approved-plan binding. Deterministic scripted transport: no live model,
 * no network.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import { resetSwarmState, swarmState } from '../../../src/state';
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

describe('normal EXECUTE journey — happy path through the registered host (#2666)', () => {
	let project: ReturnType<typeof createJourneyProject> | null = null;
	let driver: JourneyDriver | null = null;
	let cleanupEnv: (() => void) | null = null;

	beforeEach(() => {
		// Full platform-root isolation (#2033 prod-store tripwire): the
		// review-route receipt store resolves under LOCALAPPDATA/XDG_DATA_HOME
		// on real platforms; without redirection the Stage B route machinery
		// reads the developer's real store and unbinds the settlement.
		const isolated = createIsolatedTestEnv();
		cleanupEnv = isolated.cleanup;
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
		cleanupEnv?.();
		cleanupEnv = null;
		project?.cleanup();
		project = null;
		driver = null;
	});

	test('one successful task with a durable receipt at every gate', async () => {
		project = createJourneyProject('swarm-j01-');
		const booted = await bootJourneyHost({ directory: project.directory });
		driver = new JourneyDriver(booted);

		// ---- configure: registered chat.message hook starts the session.
		await driver.configure('architect');
		expect(swarmState.activeAgent.get(driver.sessionID)).toBe('architect');

		// ---- discover: registered repo_map tool.
		const discover = await driver.discover();
		expect(typeof discover).toBe('object');

		// ---- specify: registered save_plan tool writes the durable plan.
		const specify = await driver.specify(
			journeyPlanArgs({ taskId: TASK_ID, file: FILE }),
		);
		expect(specify.success).not.toBe(false);

		// ---- approve: registered approve_plan_critic + EXACT plan binding.
		const { approval, binding } = await driver.approve(
			'journey fixture j01: plan-critic approval',
		);
		expect(approval.success).not.toBe(false);
		expect(binding.success).toBe(true);
		// The identity-scoped snapshot lookup must return the approved plan
		// with NO drift (exact approved-plan binding, issue AC1).
		expect(binding.approved_plan).toBeDefined();
		expect(binding.drift_detected).toBe(false);
		expect(driver.planBinding?.planId).toBe(String(approval.plan_id));
		expect(driver.planBinding?.approvedPayloadHash).not.toBe('unknown');

		// ---- EXECUTE: declare_scope (registered v2 setter) + coder Task
		// dispatch through the MERGED registered hook chain, with the
		// child's edit landing between before and after.
		await driver.executeCoder({
			taskId: TASK_ID,
			file: FILE,
			mutate: () =>
				writeFileSync(
					path.join(project!.directory, FILE),
					'export const feature = 2;\n',
				),
		});
		let snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(project.directory, TASK_ID),
		);
		expect(snapshot.state).toBe('coder_delegated');
		expect(snapshot.generation).toBe(1);
		expect(snapshot.lastTransitionId).toBe(`coder:journey-coder-${TASK_ID}`);

		// ---- pre-check (Stage A): real scan tools through the hook chain.
		const pre = await driver.preCheck({ taskId: TASK_ID, file: FILE });
		expect(pre.gates_passed).toBe(true);
		snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(project.directory, TASK_ID),
		);
		expect(snapshot.state).toBe('pre_check_passed');

		// ---- reviewer (Stage B gate 1): exact registered verdict format.
		await driver.dispatchStageB({
			role: 'reviewer',
			taskId: TASK_ID,
			file: FILE,
			verdictLine: `[REVIEWED] | task-${TASK_ID} | APPROVED | reviewed ${TASK_ID}`,
		});
		snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(project.directory, TASK_ID),
		);
		expect(['reviewer_run', 'tests_run']).toContain(snapshot.state);

		// ---- QA (Stage B gate 2): test_engineer verdict vocabulary is
		// PASS|FAIL|SKIPPED (stage-b-gates.ts:95), never REJECTED.
		await driver.dispatchStageB({
			role: 'test_engineer',
			taskId: TASK_ID,
			file: FILE,
			verdictLine: `[TESTED] | task-${TASK_ID} | PASS | tested ${TASK_ID}`,
		});
		snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(project.directory, TASK_ID),
		);
		expect(snapshot.state).toBe('tests_run');

		// ---- finish: registered update_task_status completes the task.
		const finish = await driver.finishTask({ taskId: TASK_ID });
		expect(finish.success).not.toBe(false);
		snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(project.directory, TASK_ID),
		);
		expect(snapshot.state).toBe('complete');

		// ---- inspect control: registered check_gate_status reads the
		// durable workflow snapshot back.
		const inspect = await driver.inspectTask({ taskId: TASK_ID });
		expect(inspect.workflow).toMatchObject({ state: 'complete' });

		// ---- journey report: every stage evidenced; the validator must
		// accept the completed journey (no stdout-only stage).
		const report = driver.report({
			command: 'bun test j01-happy-path-registered',
		});
		const validation = validateJourneyReport(report);
		expect(validation.unevidencedStages).toEqual([]);
		expect(validation.reasons).toEqual([]);
		expect(report.planBinding).not.toBeNull();

		// Every stage satisfies the frozen evidence contract (durable
		// artifact OR structured receipt with tool-call + result ids), and
		// every workflow-gated stage from EXECUTE onward carries a DURABLE
		// .swarm artifact on the actual filesystem (AC1's per-gate receipt
		// requirement). Configure is evidenced by its structured hook
		// receipt (chat.message writes no file in this flow — the agent
		// identity lands in the session state and later snapshot).
		for (const stage of report.stages) {
			const evidenced =
				stage.evidence.durableArtifacts.length > 0 ||
				(stage.evidence.toolCallIds.length > 0 &&
					stage.evidence.resultIds.length > 0);
			expect({ stage: stage.name, evidenced }).toEqual({
				stage: stage.name,
				evidenced: true,
			});
			if (
				[
					'execute',
					'pre-check',
					'reviewer',
					'qa',
					'finish',
					'inspect',
				].includes(stage.name)
			) {
				expect(stage.evidence.durableArtifacts.length).toBeGreaterThan(0);
			}
			for (const rel of stage.evidence.durableArtifacts) {
				const abs = path.join(project.directory, rel);
				expect({ rel, exists: exists(abs) }).toEqual({ rel, exists: true });
			}
		}

		// Deterministic transport: every client call went through the
		// scripted seam (no live-model path is reachable).
		expect(report.transport).toBe('scripted-client');
	}, 120_000);
});

function exists(target: string): boolean {
	try {
		readFileSync(target);
		return true;
	} catch {
		return false;
	}
}
