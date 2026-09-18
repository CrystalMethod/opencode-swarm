/**
 * Issue #2817 regression tests, part 1 — the three issue-named drop sites.
 *
 * The `tool.after` Stage B parallel settlement loop drops a verdict that fails
 * a fail-closed identity/fencing condition (unbound launch generation, route
 * receipt enforcement, gate-evidence fencing). The drops are correct fencing
 * (AGENTS.md invariant 9); before #2817 they were SILENT (debug-gated
 * logger.warn only), wedging the task with no architect-visible recovery cue.
 * Every drop must now queue a `[stageb-settlement-drop:...] STAGE B SETTLEMENT
 * DROPPED` advisory naming the task and the remedy — while the drop decisions
 * themselves stay fail-closed. (Sibling coverage: capacity, rejection-persist,
 * dedupe, happy-path, and council-exclusion live in
 * delegation-gate-stage-b-settlement-drop-sites-2817.test.ts.)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import {
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { routeReceiptPathForTask } from '../../../src/review/routing-enforcement';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import {
	drainRehydrations,
	fullConfig,
	MARKER,
	makeTempDir,
	minimalConfig,
	REDISPATCH_RE,
	RESTART_RE,
	reviewerArgs,
	seedReviewerApproved,
	seedRoutedPreCheck,
	settlementDropAdvisories,
	TASK_ID,
	testEngineerArgs,
} from './_stage-b-settlement-2817-helpers.js';

let tempDir: string;
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
});

afterEach(() => {
	resetSwarmState();
	try {
		if (tempDir) {
			fs.rmSync(tempDir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 100,
			});
		}
	} catch {
		// best-effort cleanup (temp dir only)
	}
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

describe('foreground Stage B settlement drop visibility — issue-named sites (#2817)', () => {
	it('unbound (post-restart) drop queues an advisory naming task, restart cause, and re-dispatch remedy', async () => {
		const sessionID = 'sess-2817-unbound';
		tempDir = makeTempDir('dg-2817-unbound-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'unbound');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;
		const hook = createDelegationGateHook(fullConfig(), tempDir);

		// No toolBefore for this callID in this process: exactly the post-restart
		// shape, because stageBDispatchGenerationsByCallID is process-local.
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'call-2817-restarted',
				args: testEngineerArgs(),
			},
			{ output: `[TESTED] | task-${TASK_ID} | PASS | all checks green` },
		);

		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories.length).toBeGreaterThan(0);
		const advisory = advisories.find((m) => m.includes(TASK_ID)) ?? '';
		expect(advisory).toContain(MARKER);
		expect(advisory).toMatch(REDISPATCH_RE);
		expect(advisory).toMatch(RESTART_RE);
		// Fencing preserved: the drop still drops.
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('reviewer_run');
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.test_engineer).toBeUndefined();
	});

	it('route-receipt-blocked drop queues an advisory (issue #2491 fixture)', async () => {
		const sessionID = 'sess-2817-route';
		tempDir = makeTempDir('dg-2817-route-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedRoutedPreCheck(tempDir, sessionID, 'route');
		const hook = createDelegationGateHook(minimalConfig(), tempDir);
		const callID = 'call-2817-route';

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{
				args: reviewerArgs(
					`Review task-${TASK_ID} and return a structured approval.\nACCEPTANCE: return a structured approval for task-${TASK_ID}.`,
				),
			},
		);
		// Removing the persisted receipt simulates a persistence failure after
		// dispatch; enforcement must stay fail-closed but visible (#2817).
		fs.rmSync(routeReceiptPathForTask(tempDir, sessionID, TASK_ID), {
			force: true,
		});
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID,
				args: { subagent_type: 'reviewer', task_id: TASK_ID },
			},
			{ text: `[REVIEWED] | task-${TASK_ID} | APPROVED | looks good` },
		);

		const session = ensureAgentSession(sessionID);
		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories.length).toBeGreaterThan(0);
		expect(advisories.join(' ')).toMatch(REDISPATCH_RE);
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('pre_check_passed');
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.reviewer).toBeUndefined();
	});

	it('evidence-fencing throw (generation mismatch) queues an advisory', async () => {
		const sessionID = 'sess-2817-evid';
		tempDir = makeTempDir('dg-2817-evid-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'evid');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;
		const hook = createDelegationGateHook(fullConfig(), tempDir);
		const callID = 'call-2817-evid';

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{ args: testEngineerArgs() },
		);
		// Advance the durable generation after the binding so the launch
		// generation captured at dispatch is stale at settlement time.
		await transitionTaskWorkflowEvidence(tempDir, TASK_ID, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 1,
			transitionId: `evid-gen-bump:${TASK_ID}`,
		});
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID,
				args: { subagent_type: 'test_engineer', task_id: TASK_ID },
			},
			{ output: `[TESTED] | task-${TASK_ID} | PASS | all checks green` },
		);

		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories.length).toBeGreaterThan(0);
		const advisory = advisories.find((m) => m.includes(TASK_ID)) ?? '';
		expect(advisory).toMatch(REDISPATCH_RE);
		expect(advisory).toContain('TASK_WORKFLOW_GENERATION_MISMATCH');
		// Fencing preserved: no test_engineer gate recorded for the stale verdict.
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.test_engineer?.sessionId === sessionID).toBe(false);
	});
});
