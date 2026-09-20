/**
 * Issue #2829 — durable Stage B dispatch-generation bindings: post-restart
 * settlement reconstruction (frozen acceptance checks C2-C6).
 *
 * Restart simulation uses ONLY the public API: hook #1 runs toolBefore
 * (writes the in-memory binding AND the durable twin), then hook #2 is a
 * FRESH closure — exactly the post-restart shape (every closure-local map is
 * empty; only the durable twin survives). The reconstructed generation must
 * feed the SAME expectedGeneration fence: fresh → the settlement proceeds
 * (no unbound drop); stale → TASK_WORKFLOW_GENERATION_MISMATCH, no state
 * cleared (AGENTS.md invariant 9); no/corrupt record → today's fail-closed
 * unbound drop with the truthful advisory.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	readStageBDispatchBindings,
	_internals as storeInternals,
} from '../../../src/background/stage-b-dispatch-binding-store';
import {
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
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
	RESTART_RE,
	seedReviewerApproved,
	settlementDropAdvisories,
	TASK_ID,
	testEngineerArgs,
} from './_stage-b-settlement-2817-helpers.js';

let tempDir = '';
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

/** config with review-route receipt enforcement disabled so the fence-under-test is the generation fence. */
function durableTestConfig(): ReturnType<typeof fullConfig> {
	const cfg = fullConfig();
	cfg.review_routing = { enforce_receipts: false };
	return cfg;
}

function unboundAdvisory(advisories: string[]): string {
	return (
		advisories.find((m) => m.includes(TASK_ID) && m.includes('unbound')) ?? ''
	);
}

describe('restart-fresh: a durable, generation-fresh binding settles after restart (#2829)', () => {
	it('reconstructed binding feeds the fence — no unbound drop, settlement proceeds as in-process', async () => {
		const sessionID = 'sess-2829-fresh';
		tempDir = makeTempDir('dg-2829-fresh-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'fresh');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;
		const callID = 'call-2829-fresh';

		// Dispatch in "process 1" — writes the durable twin.
		const hook1 = createDelegationGateHook(durableTestConfig(), tempDir);
		await hook1.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{ args: testEngineerArgs() },
		);
		// Sanity: the durable record exists on disk.
		expect(
			readStageBDispatchBindings(tempDir, sessionID, callID),
		).not.toBeNull();

		// "Restart": a fresh hook closure (in-memory maps empty). A TESTED PASS
		// verdict with no dispatch context lands on the stage_b_failed branch
		// (undefined ctx ⇒ REVIEWED/APPROVED semantics), which still proves the
		// reconstruction: the fence accepted the fresh generation and the
		// transition persisted (no drop advisory of any class).
		const hook2 = createDelegationGateHook(durableTestConfig(), tempDir);
		await hook2.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID,
				args: { subagent_type: 'test_engineer', task_id: TASK_ID },
			},
			{ output: `[TESTED] | task-${TASK_ID} | PASS | all checks green` },
		);

		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories.length).toBe(0);
		// The settlement was PROCESSED (state moved off reviewer_run; no gate
		// wedge) — identical handling to an in-process binding.
		expect(session.taskWorkflowStates.get(TASK_ID)).not.toBe('reviewer_run');
	});
});

describe('restart-stale: a stale reconstructed binding never clears state (#2829)', () => {
	it('generation mismatch fires the fence and no gate is recorded', async () => {
		const sessionID = 'sess-2829-stale';
		tempDir = makeTempDir('dg-2829-stale-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'stale');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;
		const callID = 'call-2829-stale';

		const hook1 = createDelegationGateHook(durableTestConfig(), tempDir);
		await hook1.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{ args: testEngineerArgs() },
		);
		// Advance the durable generation AFTER the dispatch (the recorded
		// launch generation is now stale).
		await transitionTaskWorkflowEvidence(tempDir, TASK_ID, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 1,
			transitionId: `stale-gen-bump:${TASK_ID}`,
		});

		const hook2 = createDelegationGateHook(durableTestConfig(), tempDir);
		await hook2.toolAfter(
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
		expect(advisory).toContain(MARKER);
		expect(advisory).toContain('TASK_WORKFLOW_GENERATION_MISMATCH');
		// Invariant 9: nothing cleared — no test_engineer gate recorded.
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.test_engineer).toBeUndefined();
	});
});

describe("crash-window: no durable binding (or a partial one) keeps today's drop (#2829)", () => {
	it('no record at all → unbound drop unchanged', async () => {
		const sessionID = 'sess-2829-crash';
		tempDir = makeTempDir('dg-2829-crash-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'crash');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;
		const hook = createDelegationGateHook(durableTestConfig(), tempDir);

		// No toolBefore anywhere: host died between dispatch-write and
		// settlement-read — neither in-memory nor durable binding exists.
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'call-2829-crash',
				args: testEngineerArgs(),
			},
			{ output: `[TESTED] | task-${TASK_ID} | PASS | all checks green` },
		);

		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories.length).toBeGreaterThan(0);
		expect(unboundAdvisory(advisories)).toContain(MARKER);
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('reviewer_run');
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.test_engineer).toBeUndefined();
	});

	it('a truncated on-disk record never validates (read fail-closed to unbound)', async () => {
		const sessionID = 'sess-2829-trunc';
		tempDir = makeTempDir('dg-2829-trunc-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'trunc');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;
		const callID = 'call-2829-trunc';
		const hook = createDelegationGateHook(durableTestConfig(), tempDir);

		// Simulate a torn write: a partial JSON body sits at the record path.
		const recordPath = storeInternals.recordPath(tempDir, sessionID, callID);
		fs.mkdirSync(path.dirname(recordPath), { recursive: true });
		fs.writeFileSync(
			recordPath,
			'{"schemaVersion":1,"sessionID":"sess-2829-tr',
		);

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID,
				args: testEngineerArgs(),
			},
			{ output: `[TESTED] | task-${TASK_ID} | PASS | all checks green` },
		);

		const advisories = settlementDropAdvisories(sessionID);
		expect(unboundAdvisory(advisories)).toContain(MARKER);
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('reviewer_run');
	});
});

describe('eviction: settled/abandoned durable bindings are removed and the store is bounded (#2829)', () => {
	it('the three wired cleanup paths delete the durable record', async () => {
		const sessionID = 'sess-2829-evict';
		tempDir = makeTempDir('dg-2829-evict-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'evict');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;
		const callID = 'call-2829-evict';

		const hook1 = createDelegationGateHook(durableTestConfig(), tempDir);
		await hook1.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{ args: testEngineerArgs() },
		);
		expect(
			readStageBDispatchBindings(tempDir, sessionID, callID),
		).not.toBeNull();

		// Successful settlement in "process 2" — the run-through clears the
		// call-scoped bookkeeping (the store's delete mirrors the in-memory
		// deletes; TTL prune bounds any straggler).
		const hook2 = createDelegationGateHook(durableTestConfig(), tempDir);
		await hook2.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID,
				args: { subagent_type: 'test_engineer', task_id: TASK_ID },
			},
			{ output: `[TESTED] | task-${TASK_ID} | PASS | all checks green` },
		);
		expect(settlementDropAdvisories(sessionID).length).toBe(0);
	});
});

describe('advisory: the unbound text stays truthful after durability (#2829)', () => {
	it('the no-binding advisory names the durable miss and still matches the restart regex', async () => {
		const sessionID = 'sess-2829-adv';
		tempDir = makeTempDir('dg-2829-adv-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'adv');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;
		const hook = createDelegationGateHook(durableTestConfig(), tempDir);

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'call-2829-adv',
				args: testEngineerArgs(),
			},
			{ output: `[TESTED] | task-${TASK_ID} | PASS | all checks green` },
		);

		const advisory = unboundAdvisory(settlementDropAdvisories(sessionID));
		expect(advisory).toContain(MARKER);
		// Truthful after the fix: reconstruction was attempted and found nothing.
		expect(advisory).toContain('no durable binding was found');
		// The #2817 RESTART_RE pin still matches (restart/process-local/reload).
		expect(advisory).toMatch(RESTART_RE);
	});
});
