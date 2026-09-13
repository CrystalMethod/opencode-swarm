/**
 * j03 — bounded cancellation controls (AC3, issue #2666). Two controls, both
 * bounded in wall-clock:
 *  (a) lane-level cancel through the REGISTERED cancellation surface —
 *      dispatch_lanes_async with a scripted client whose prompts never
 *      resolve, then collect_lane_results cancel_pending → lanes settle
 *      `cancelled` (typed terminal, session.abort recorded).
 *  (b) EXECUTE-scope bounded abandon — a coder Task dispatch admitted
 *      (settlement DISPATCHED) whose child never completes: the registered
 *      `event` hook session.deleted path clears session state BOUNDED and
 *      intentionally leaves the settlement WAL DISPATCHED (durable recovery
 *      input for /swarm recover) — this test pins that boundary and proves
 *      the lost task is never finished.
 *
 * Labeled gap (documented in docs/testing/execute-journey.md): the repo has
 * no dedicated EXECUTE-scope coder-cancel tool; control (a) qualifies the
 * registered lane-cancel surface and control (b) the registered session-end
 * boundary.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findByBatchId } from '../../../src/background/pending-delegations';
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
	parseToolResult,
	ScriptedHostClient,
} from '../../helpers/execute-journey-driver';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';

const TASK_ID = '1.1';
const FILE = 'src/feature.ts';
/** Generous bound; the bun test timeout is the hard backstop. */
const CANCEL_WALL_CLOCK_BOUND_MS = 30_000;

describe('bounded cancellation through the registered host (#2666)', () => {
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

	test('collect_lane_results cancel_pending settles pending lanes cancelled, bounded', async () => {
		project = createJourneyProject('swarm-j03a-');
		// Scripted client whose prompts NEVER resolve: the lanes stay
		// pending until the registered cancellation surface aborts them.
		const client = new ScriptedHostClient();
		client.promptBehavior = () => new Promise(() => {});
		const booted = await bootJourneyHost({
			directory: project.directory,
			client,
		});
		const driver = new JourneyDriver(booted);
		await driver.configure();

		const batchId = 'journey-cancel-batch-1';
		const dispatch = parseToolResult(
			await booted.host.tool.dispatch_lanes_async.execute(
				{
					batch_id: batchId,
					mode: 'journey-cancel-probe',
					max_concurrent: 2,
					lanes: [
						{
							id: 'journey-lane-1',
							agent: 'explorer',
							prompt: 'Probe the fixture; this prompt never resolves.',
						},
						{
							id: 'journey-lane-2',
							agent: 'explorer',
							prompt: 'Second never-resolving lane probe.',
						},
					],
				},
				{ directory: project.directory, sessionID: driver.sessionID },
			),
		);
		expect(dispatch.success).toBe(true);

		const cancelStartedAt = performance.now();
		const cancel = parseToolResult(
			await booted.host.tool.collect_lane_results.execute(
				{ batch_id: batchId, cancel_pending: true },
				{ directory: project.directory, sessionID: driver.sessionID },
			),
		);
		const cancelElapsedMs = performance.now() - cancelStartedAt;
		// The envelope's `success` flag means COMPLETED work; a pure-cancel
		// result legitimately reports success=false with cancelled>0. The
		// functional contract is: every lane settled cancelled, nothing
		// pending, all settled — bounded in wall-clock.
		expect(cancel.cancelled).toBe(2);
		expect(cancel.pending).toBe(0);
		expect(cancel.all_settled).toBe(true);
		// Bounded: the registered cancel returns promptly — no hang.
		expect(cancelElapsedMs).toBeLessThan(CANCEL_WALL_CLOCK_BOUND_MS);

		const records = findByBatchId(project.directory, batchId);
		expect(records.length).toBe(2);
		for (const record of records) {
			expect(record.status).toBe('cancelled');
		}
		// The scripted client observed the abort (bounded, typed surface).
		expect(client.calls.some((call) => call.surface === 'session.abort')).toBe(
			true,
		);
	}, 120_000);

	test('an abandoned coder dispatch stays unfinished through the registered session.deleted event', async () => {
		project = createJourneyProject('swarm-j03b-');
		const booted = await bootJourneyHost({ directory: project.directory });
		const driver = new JourneyDriver(booted);
		await driver.configure();
		await driver.specify(journeyPlanArgs({ taskId: TASK_ID, file: FILE }));
		await driver.approve('journey fixture j03: plan-critic approval');

		// Dispatch the coder but never deliver completion: the child is
		// "lost" with the settlement left DISPATCHED.
		const args = {
			subagent_type: 'coder',
			task_id: TASK_ID,
			prompt: `TASK: ${TASK_ID}\nFILE: ${FILE}\nACCEPTANCE: abandoned dispatch`,
		};
		const callID = 'journey-coder-abandoned';
		await booted.host.hooks['tool.execute.before'](
			{ tool: 'Task', sessionID: driver.sessionID, callID },
			{ args },
		);
		// Verify the dispatch actually began: the coder-settlement WAL was
		// written DISPATCHED by the delegation-gate toolBefore.
		const walPath = path.join(
			project.directory,
			'.swarm',
			'coder-settlements',
			`${TASK_ID}.json`,
		);
		expect(JSON.parse(readFileSync(walPath, 'utf8'))).toMatchObject({
			state: 'DISPATCHED',
		});

		const abandonedAt = performance.now();
		// The host's session-end lifecycle event fires through the registered
		// `event` hook (src/index.ts:3286/3440). It clears session state
		// bounded — it does NOT settle the coder dispatch WAL (that is the
		// /swarm recover path's job, src/workflow/coder-settlement.ts
		// recoverStaleCoderSettlements); this test pins that boundary.
		await booted.host.hooks['event']({
			event: {
				type: 'session.deleted',
				properties: { sessionID: driver.sessionID },
			},
		});
		const settleElapsedMs = performance.now() - abandonedAt;
		// Bounded: the session-end event returns promptly — no hang.
		expect(settleElapsedMs).toBeLessThan(CANCEL_WALL_CLOCK_BOUND_MS);
		// The abandoned task is never finished by the session-end event...
		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(project.directory, TASK_ID),
		);
		expect(snapshot.state).not.toBe('complete');
		expect(snapshot.lastOutcome).not.toBe('task_completed');
		// ...and the dispatch WAL is INTENTIONALLY left DISPATCHED (the
		// durable recovery input for /swarm recover), not silently rewritten.
		expect(JSON.parse(readFileSync(walPath, 'utf8'))).toMatchObject({
			state: 'DISPATCHED',
		});
	}, 120_000);
});
