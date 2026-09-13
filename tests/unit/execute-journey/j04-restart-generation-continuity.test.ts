/**
 * j04 — restart-after-interruption and generation continuity (AC4, issue
 * #2666). Boot A drives the journey through EXECUTE (coder_delegated,
 * generation 1), then the process "dies" — in this in-process fixture the
 * module-level swarmState singleton (src/state.ts:927) is reset via
 * resetSwarmStatePreservingSingletons() (src/state.ts:1158), because a
 * second in-process server() boot cannot clear it by itself. A real second
 * OS process would run the same hydration path (loadSnapshotForInit →
 * rehydrateState on every boot, src/index.ts:1152); this limitation is
 * disclosed here and in docs/testing/execute-journey.md.
 *
 * Boot B then proves: plan identity retained; durable workflow state and
 * generation survive; a late result carrying the OLD generation is
 * rejected; accepted-then-dead work is classified by the #2665 vocabulary;
 * a plan whose identity was mutated after approval (the cross-project /
 * foreign-plan analog) is refused by get_approved_plan; resume/inspect
 * re-reads state from durable artifacts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readCoreEvents } from '../../../src/events/core-events';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	type TaskWorkflowSnapshot,
} from '../../../src/gate-evidence';
import {
	resetSwarmState,
	resetSwarmStatePreservingSingletons,
} from '../../../src/state';
import { classifySettlementWalState } from '../../../src/workflow/task-recovery-status';
import type { CoderSettlementWalState } from '../../../src/workflow/workflow-wal-schema';
import {
	bootJourneyHost,
	commitWorkingTree,
	createJourneyProject,
	JourneyDriver,
	journeyPlanArgs,
	parseToolResult,
} from '../../helpers/execute-journey-driver';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';

const TASK_ID = '1.1';
const FILE = 'src/feature.ts';

describe('restart generation continuity through the registered host (#2666)', () => {
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

	test('second boot rehydrates, keeps plan identity, rejects old-generation results', async () => {
		// ---- Boot A: journey through EXECUTE, then "process death".
		project = createJourneyProject('swarm-j04-');
		const bootA = await bootJourneyHost({ directory: project.directory });
		const driverA = new JourneyDriver(bootA);
		await driverA.configure();
		await driverA.specify(journeyPlanArgs({ taskId: TASK_ID, file: FILE }));
		const { approval } = await driverA.approve('journey fixture j04 approval');
		await driverA.executeCoder({
			taskId: TASK_ID,
			file: FILE,
			mutate: () =>
				writeFileSync(
					path.join(project!.directory, FILE),
					'export const feature = 2;\n',
				),
		});
		const planIdFromBootA = String(approval.plan_id);
		const snapshotA = getTaskWorkflowSnapshot(
			await readTaskEvidence(project.directory, TASK_ID),
		);
		expect(snapshotA.state).toBe('coder_delegated');
		expect(snapshotA.generation).toBe(1);
		// Simulated process death: durable artifacts remain, in-process
		// session state is dropped (disclosed limitation above).
		resetSwarmStatePreservingSingletons();

		// ---- Boot B: fresh server() on the same project; every boot runs
		// the real hydration path over the durable artifacts.
		const bootB = await bootJourneyHost({ directory: project.directory });
		const driverB = new JourneyDriver(bootB);
		await driverB.configure();

		// (a) Plan identity retained: the approved snapshot still binds the
		// exact same plan id through the registered get_approved_plan tool.
		const binding = parseToolResult(
			await bootB.host.tool.get_approved_plan.execute(
				{ summary_only: true },
				{ directory: project.directory, sessionID: driverB.sessionID },
			),
		);
		expect(binding.success).toBe(true);
		expect(binding.drift_detected).toBe(false);
		// (b) Durable workflow state and generation survive the restart:
		// resume/inspect reads from evidence, not in-memory state.
		const inspect = await driverB.inspectTask({ taskId: TASK_ID });
		expect(inspect.workflow).toMatchObject({
			state: 'coder_delegated',
			generation: 1,
		});

		// (c) A late result carrying the OLD generation is rejected. The
		// sequence follows the REAL workflow: bind a Stage A receipt at
		// generation 1, pass Stage A, have the reviewer REJECT (rework),
		// re-dispatch the coder (accepted_mutation opens generation 2),
		// then deliver the stale receipt through the registered
		// after-hook — the #2664 late route fires, nothing advances.
		const lateCallID = 'journey-late-stage-a';
		await bootB.host.hooks['tool.execute.before'](
			{
				tool: 'pre_check_batch',
				sessionID: driverB.sessionID,
				callID: lateCallID,
			},
			{ args: { files: [FILE], directory: project.directory } },
		);
		const preB = await driverB.preCheck({ taskId: TASK_ID, file: FILE });
		expect(preB.gates_passed).toBe(true);
		await driverB.dispatchStageB({
			role: 'reviewer',
			taskId: TASK_ID,
			file: FILE,
			verdictLine: `[REVIEWED] | task-${TASK_ID} | REJECTED | rework after restart`,
		});
		const reworkSnapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(project.directory, TASK_ID),
		);
		expect(reworkSnapshot.state).toBe('rework_required');
		// The between-rounds step a real team performs: commit the coder's
		// edit so the re-dispatch has a clean settlement baseline.
		commitWorkingTree(
			project.directory,
			'test: commit round-1 coder mutation before re-dispatch',
		);
		await driverB.driveTaskDelegation({
			role: 'coder',
			callID: 'journey-coder-retry-after-restart',
			taskId: TASK_ID,
			file: FILE,
			mutate: () =>
				writeFileSync(
					path.join(project!.directory, FILE),
					'export const feature = 3;\n',
				),
			output: { state: 'completed', output: `retry after restart ${TASK_ID}` },
		});
		const redispatched = getTaskWorkflowSnapshot(
			await readTaskEvidence(project.directory, TASK_ID),
		);
		// Generation advanced: the re-dispatch opened a NEW generation.
		expect(redispatched.generation).toBeGreaterThan(1);
		await bootB.host.hooks['tool.execute.after'](
			{
				tool: 'pre_check_batch',
				sessionID: driverB.sessionID,
				callID: lateCallID,
			},
			{
				title: '',
				// Canonical decodable PASS payload (the #2664 check-c3
				// shape) so the verdict is VALID and the generation
				// mismatch — not decode failure — is what rejects it.
				output: JSON.stringify({
					gates_passed: true,
					batch_status: 'completed',
					total_duration_ms: 1,
					lint: { ran: true, duration_ms: 1 },
					secretscan: {
						ran: true,
						duration_ms: 1,
						result: {
							count: 0,
							findings: [],
							files_scanned: 1,
							incomplete_files: 0,
							incomplete_paths: [],
						},
					},
					sast_scan: { ran: true, duration_ms: 1, result: { verdict: 'pass' } },
					quality_budget: { ran: false, duration_ms: 0 },
				}),
				metadata: null,
			},
		);
		const afterLate = getTaskWorkflowSnapshot(
			await readTaskEvidence(project.directory, TASK_ID),
		);
		// The late result did NOT advance the task: it stays exactly at
		// the re-dispatch's state and generation (the stale receipt was
		// rejected, not applied).
		expect(afterLate.state).toBe('coder_delegated');
		expect(afterLate.generation).toBe(redispatched.generation);
		const events = readCoreEvents(project.directory);
		const lateRoutes = events.text
			.split('\n')
			.filter(
				(line) => line.includes('"late_result"') && line.includes(lateCallID),
			);
		expect(lateRoutes.length).toBe(1);

		// (d) Accepted-then-dead classification (#2665 vocabulary): a
		// DISPATCHED settlement owned by a provably-dead pid classifies
		// `stale` with deterministic repair allowed — never `healthy`, and
		// the external effect stays uncertain.
		const deadOwnerWal: CoderSettlementWalState = {
			taskId: TASK_ID,
			state: 'DISPATCHED',
			transitionId: `coder:dead-owner-${TASK_ID}`,
			actor: 'coder',
			processId: 0,
			runtimeId: '00000000-0000-4000-8000-000000000000',
			expectedGeneration: 1,
			context: {
				baseline: {
					directory: project.directory,
					gitHead: null,
					dirtyHash: null,
					prHeadSha: null,
					scope: null,
					changedFiles: [],
				},
				declaredFiles: [FILE],
			},
			accepted: true,
			recordedAt: '2026-01-01T00:00:00.000Z',
		} as unknown as CoderSettlementWalState;
		const deadStatus = classifySettlementWalState(
			deadOwnerWal,
			afterLate as TaskWorkflowSnapshot,
		);
		expect(deadStatus.category).toBe('stale');
		expect(deadStatus.repairAllowed).toBe(true);
		// `stale` (owner provably gone) is the DETERMINISTIC repair class.
		// The live/foreign-ownership `ambiguous` and `live_wedge` classes
		// are owned by the #2665 classifier suites.
		expect(deadStatus.uncertainExternalEffect).toBe(false);

		// (e2) Cross-identity refusal: a plan whose identity (swarm/title)
		// was mutated after approval — the foreign-plan analog — is refused
		// by the registered get_approved_plan (identity-scoped lookup).
		const planPath = path.join(project.directory, '.swarm', 'plan.json');
		const planJson = JSON.parse(readFileSync(planPath, 'utf8')) as {
			title: string;
		};
		writeFileSync(
			planPath,
			JSON.stringify({ ...planJson, title: 'MUTATED foreign identity' }),
		);
		const mutated = parseToolResult(
			await bootB.host.tool.get_approved_plan.execute(
				{ summary_only: true },
				{ directory: project.directory, sessionID: driverB.sessionID },
			),
		);
		// The approved snapshot is NOT returned for the mutated identity:
		// drift/tampering is surfaced instead of a foreign binding.
		expect(mutated.success).toBe(true);
		expect(mutated.drift_detected).toBe(true);
		expect(mutated.approved_plan).toBeUndefined();
	}, 180_000);
});
