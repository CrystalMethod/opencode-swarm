/**
 * j03 — bounded cancellation controls (AC3, issue #2666; revised for #2971).
 * Two controls, both bounded in wall-clock:
 *  (a) lane-level cancellation through the REGISTERED surfaces — a scripted
 *      client whose prompts never resolve, then collect_lane_results with
 *      cancel_pending (OBSERVATION ONLY since #2971: cancelled=0, lanes stay
 *      pending/running, no session.abort, typed cancellation_refused guidance
 *      naming cancel_lane_batch), followed by the confirmed cancellation
 *      through the registered cancel_lane_batch host tool: idle lanes settle
 *      cancelled with the distinct operator_cancelled class, session.abort
 *      observed, bounded in wall-clock.
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

	test('cancel_pending is guidance-only; confirmed cancel_lane_batch settles idle lanes operator_cancelled, bounded', async () => {
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

		// Phase 1 (issue #2971): an ordinary cancel_pending request is
		// OBSERVATION-ONLY — it never aborts or settles a lane. The collector
		// answers with typed refusal guidance naming the authorized surface.
		const observeStartedAt = performance.now();
		const observe = parseToolResult(
			await booted.host.tool.collect_lane_results.execute(
				{ batch_id: batchId, cancel_pending: true },
				{ directory: project.directory, sessionID: driver.sessionID },
			),
		);
		const observeElapsedMs = performance.now() - observeStartedAt;
		expect(observe.cancelled).toBe(0);
		expect(observe.pending).toBe(2);
		expect(observe.all_settled).toBe(false);
		const refusals = (observe.cancellation_refused ?? []) as Array<{
			lane_id: string;
			next_action: string;
		}>;
		expect(refusals).toHaveLength(2);
		for (const refusal of refusals) {
			expect(refusal.next_action).toContain('cancel_lane_batch');
		}
		expect(String(observe.message ?? '')).toContain('cancel_lane_batch');
		// No abort was issued and the lanes are still open work.
		expect(client.calls.some((call) => call.surface === 'session.abort')).toBe(
			false,
		);
		let records = findByBatchId(project.directory, batchId);
		expect(records.length).toBe(2);
		for (const record of records) {
			expect(['pending', 'running']).toContain(record.status);
		}
		// Bounded: the observation-only collect returns promptly — no hang.
		expect(observeElapsedMs).toBeLessThan(CANCEL_WALL_CLOCK_BOUND_MS);

		// Phase 2: the confirmed cancellation through the REGISTERED host tool.
		// The host builds its tool map from the manifest — verify the surface
		// is exposed, then make the scripted host report every lane session
		// idle so the liveness preflight admits the cancellation.
		const cancelTool = booted.host.tool.cancel_lane_batch;
		expect(cancelTool).toBeDefined();
		const idleStatusMap: Record<string, { type: string }> = {};
		for (const record of records) {
			idleStatusMap[record.subagentSessionId] = { type: 'idle' };
		}
		(client.session as unknown as Record<string, unknown>).status =
			async () => ({ data: idleStatusMap, error: undefined });

		const cancelStartedAt = performance.now();
		const cancel = parseToolResult(
			await cancelTool.execute(
				{
					batch_id: batchId,
					reason: 'journey j03: bounded operator cancellation',
					confirm: true,
				},
				{ directory: project.directory, sessionID: driver.sessionID },
			),
		);
		const cancelElapsedMs = performance.now() - cancelStartedAt;
		// The functional contract: every lane settled cancelled through the
		// distinct operator_cancelled class, bounded in wall-clock.
		expect(cancel.cancelled).toBe(2);
		expect(cancelElapsedMs).toBeLessThan(CANCEL_WALL_CLOCK_BOUND_MS);

		records = findByBatchId(project.directory, batchId);
		expect(records.length).toBe(2);
		for (const record of records) {
			expect(record.status).toBe('cancelled');
			expect(record.terminalResult?.result?.workflowLaneFailureClass).toBe(
				'operator_cancelled',
			);
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
