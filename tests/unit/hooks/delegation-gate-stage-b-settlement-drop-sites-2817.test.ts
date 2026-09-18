/**
 * Issue #2817 regression tests, part 2 — sweep-found drop sites, dedupe,
 * happy path, and council exclusion. (The three issue-named drop sites live
 * in delegation-gate-stage-b-settlement-drop-advisory-2817.test.ts; shared
 * fixtures in _stage-b-settlement-2817-helpers.ts.)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import type { PluginConfig } from '../../../src/config';
import { setGatesForIdentity } from '../../../src/db/qa-gate-profile';
import {
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import type { ReviewRouteEvidence } from '../../../src/review/routing-enforcement';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import {
	drainRehydrations,
	fullConfig,
	makeTempDir,
	PLAN_TITLE,
	REDISPATCH_RE,
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

describe('foreground Stage B settlement drop visibility — sweep sites + preserving legs (#2817)', () => {
	it('route-evidence capacity drop queues an advisory', async () => {
		const sessionID = 'sess-2817-cap';
		tempDir = makeTempDir('dg-2817-cap-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedRoutedPreCheck(tempDir, sessionID, 'cap');
		// The 32-entry reservation cap is only reachable past route enforcement
		// when enforcement is disabled: under enforcement every prospective
		// receipt must carry a listed route identity (duplicates rejected), so
		// valid per-task evidence cannot reach the cap. This mirrors the
		// enforce_receipts:false fixture of issue-2491-direct-route-gate.test.ts.
		const hook = createDelegationGateHook(
			{
				hooks: { delegation_gate: true },
				review_routing: { enforce_receipts: false },
			} as PluginConfig,
			tempDir,
		);
		const callID = 'call-2817-cap';

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{
				args: reviewerArgs(
					`Review task-${TASK_ID} and return a structured approval.\nACCEPTANCE: return a structured approval for task-${TASK_ID}.`,
				),
			},
		);
		// Fill the per-task route-evidence projection to its 32-entry cap with
		// entries whose dispatch identities differ from this dispatch, so the
		// settlement's reservation cannot find or replace its own slot.
		const session = ensureAgentSession(sessionID);
		const filler: ReviewRouteEvidence[] = Array.from(
			{ length: 32 },
			(_, i) =>
				({
					role: 'reviewer',
					identity: `cap-filler-${i}`,
					sessionId: sessionID,
					taskId: TASK_ID,
					callId: `call-filler-${i}`,
					childSessionId: `child-filler-${i}`,
					generation: i,
				}) as ReviewRouteEvidence,
		);
		session.stageBRouteEvidence = new Map([[TASK_ID, filler]]);

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID,
				args: { subagent_type: 'reviewer', task_id: TASK_ID },
			},
			{ text: `[REVIEWED] | task-${TASK_ID} | APPROVED | looks good` },
		);

		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories.length).toBeGreaterThan(0);
		expect(advisories.join(' ')).toMatch(/capacity/i);
		expect(advisories.join(' ')).toMatch(REDISPATCH_RE);
		// Fencing preserved: nothing settled.
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.reviewer?.sessionId === sessionID).toBe(false);
	});

	it('rejection-persist failure queues the distinct rejection advisory (no clean-verdict wording)', async () => {
		const sessionID = 'sess-2817-rej';
		tempDir = makeTempDir('dg-2817-rej-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'rej');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;
		const hook = createDelegationGateHook(fullConfig(), tempDir);
		const callID = 'call-2817-rej';

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{ args: testEngineerArgs() },
		);
		// Stale the durable generation so persisting the REJECTED verdict
		// (stage_b_failed transition) throws inside the settlement loop.
		await transitionTaskWorkflowEvidence(tempDir, TASK_ID, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 1,
			transitionId: `rej-gen-bump:${TASK_ID}`,
		});
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID,
				args: { subagent_type: 'test_engineer', task_id: TASK_ID },
			},
			{ output: `[TESTED] | task-${TASK_ID} | FAIL | tests broke` },
		);

		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories.length).toBeGreaterThan(0);
		const advisory = advisories.find((m) => m.includes(TASK_ID)) ?? '';
		expect(advisory).toContain('rejection verdict was not persisted');
		expect(advisory).toContain('.swarm/');
		// Distinct wording: no clean-verdict claim, no re-dispatch remedy on this leg.
		expect(advisory).not.toContain('clean verdict');
		expect(advisory).not.toMatch(REDISPATCH_RE);
		// Fencing preserved: the rejection did not land, task stays eligible.
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('reviewer_run');
	});

	it('dedupes a repeated same-class drop for the same task within one turn', async () => {
		const sessionID = 'sess-2817-dedupe';
		tempDir = makeTempDir('dg-2817-dedupe-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'dedupe');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;
		const hook = createDelegationGateHook(fullConfig(), tempDir);
		const args = testEngineerArgs();

		// Two unbound settlements for the same task (different callIDs, same
		// reason class) in one turn: pushAdvisory's dedupe key collapses them.
		await hook.toolAfter(
			{ tool: 'Task', sessionID, callID: 'call-2817-dedupe-a', args },
			{ output: `[TESTED] | task-${TASK_ID} | PASS | ok` },
		);
		await hook.toolAfter(
			{ tool: 'Task', sessionID, callID: 'call-2817-dedupe-b', args },
			{ output: `[TESTED] | task-${TASK_ID} | PASS | ok` },
		);

		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories.length).toBe(1);
	});

	it('bound clean settlement still settles and advances (fencing intact, happy path)', async () => {
		const sessionID = 'sess-2817-happy';
		tempDir = makeTempDir('dg-2817-happy-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedRoutedPreCheck(tempDir, sessionID, 'happy');
		const hook = createDelegationGateHook(
			{ hooks: { delegation_gate: true } } as PluginConfig,
			tempDir,
		);
		const callID = 'call-2817-happy';

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{
				args: reviewerArgs(
					`Reviewer task-${TASK_ID}.\nACCEPTANCE: return a structured reviewer result for task-${TASK_ID}.`,
				),
			},
		);
		await hook.taskMetadata({
			callID,
			parentSessionID: sessionID,
			childSessionID: 'child-2817-happy',
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
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('reviewer_run');
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.reviewer).toBeDefined();
		expect(session.stageBCompletion?.get(TASK_ID)?.has('reviewer')).toBe(true);
		// No drop advisory on the happy path.
		expect(settlementDropAdvisories(sessionID).length).toBe(0);
	});

	it('council mode does not emit settlement-drop advisories (council owns advancement)', async () => {
		const sessionID = 'sess-2817-council';
		tempDir = makeTempDir('dg-2817-council-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'council');
		setGatesForIdentity(
			tempDir,
			{ swarm: 'test', title: PLAN_TITLE },
			{ council_mode: true },
		);
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;
		const hook = createDelegationGateHook(
			{
				hooks: { delegation_gate: true },
				council: { enabled: true },
			} as PluginConfig,
			tempDir,
		);

		// Would be an unbound drop outside council mode; under council the whole
		// settlement block is skipped, so nothing may be emitted.
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'call-2817-council-restarted',
				args: testEngineerArgs(),
			},
			{ output: `[TESTED] | task-${TASK_ID} | PASS | all checks green` },
		);

		expect(settlementDropAdvisories(sessionID).length).toBe(0);
	});
});
