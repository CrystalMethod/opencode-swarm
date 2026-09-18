/**
 * Issue #2817 regression tests, part 2 — sweep-found drop sites, dedupe,
 * aggregation/host-log coverage, second-turn re-advise, happy path, and
 * council exclusion. (The three issue-named drop sites live in
 * delegation-gate-stage-b-settlement-drop-advisory-2817.test.ts; shared
 * fixtures in _stage-b-settlement-2817-helpers.ts.)
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import type { PluginConfig } from '../../../src/config';
import { closeProjectDb } from '../../../src/db/project-db';
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
import * as logger from '../../../src/utils/logger';
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
	writePlan,
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
		// setGatesForIdentity (council test) caches a project DB handle for
		// tempDir; release it before the recursive delete (Windows EBUSY).
		if (tempDir) closeProjectDb(tempDir);
	} catch {
		// best-effort handle release
	}
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
		// Fencing preserved: nothing settled — no reviewer gate evidence at all
		// (the fixture seeds none; any recorded gate would be a regression).
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.reviewer).toBeUndefined();
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
		// Fencing preserved: the rejection did not land — no test_engineer gate
		// evidence (the fixture seeds only a reviewer gate) and the task stays
		// eligible.
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.test_engineer).toBeUndefined();
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

	it('multi-task drop: per-task advisories survive prefix task ids and ONE aggregated criticalWarn line fires per class', async () => {
		const sessionID = 'sess-2817-multi';
		tempDir = makeTempDir('dg-2817-multi-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		// 1.1 and 1.10: the bracket-terminated dedupe token must keep the
		// shorter task's advisory from being substring-suppressed by the longer
		// task's queued message (PRR-004). The plan fixture must genuinely
		// carry BOTH tasks (not a single-task plan with manual session seeding).
		writePlan(tempDir, ['1.1', '1.10']);
		const writtenPlan = JSON.parse(
			fs.readFileSync(`${tempDir}/.swarm/plan.json`, 'utf8'),
		) as { phases: { tasks: { id: string }[] }[] };
		expect(writtenPlan.phases[0]?.tasks.map((task) => task.id)).toEqual([
			'1.1',
			'1.10',
		]);
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set('1.1', 'reviewer_run');
		session.taskWorkflowStates.set('1.10', 'reviewer_run');
		session.currentTaskId = '1.1';
		const hook = createDelegationGateHook(fullConfig(), tempDir);
		const criticalWarnSpy = spyOn(logger, 'criticalWarn').mockImplementation(
			() => {},
		);

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'call-2817-multi',
				args: testEngineerArgs(),
			},
			{
				output: `[TESTED] | task-1.10 | PASS | ok\n[TESTED] | task-1.1 | PASS | ok`,
			},
		);

		// BOTH per-task advisories are queued — neither suppressed by the other.
		const advisories = settlementDropAdvisories(sessionID);
		expect(
			advisories.some((m) =>
				m.includes('[stageb-settlement-drop:unbound:1.1]'),
			),
		).toBe(true);
		expect(
			advisories.some((m) =>
				m.includes('[stageb-settlement-drop:unbound:1.10]'),
			),
		).toBe(true);
		// Aggregated host-log: exactly one criticalWarn for the unbound class,
		// naming both tasks on one line. (Read mock.calls BEFORE mockRestore —
		// restoring clears the call log.)
		const dropLines = criticalWarnSpy.mock.calls
			.map((call) => String(call[0] ?? ''))
			.filter((line) => line.includes('Stage B settlement dropped'));
		criticalWarnSpy.mockRestore();
		expect(dropLines.length).toBe(1);
		expect(dropLines[0]).toContain('1.1');
		expect(dropLines[0]).toContain('1.10');
		expect(dropLines[0]).toContain('unbound');
	});

	it('caps the aggregated host-log task list at ten with an exact overflow count', async () => {
		const sessionID = 'sess-2817-overflow';
		tempDir = makeTempDir('dg-2817-overflow-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		// 12 eligible tasks drop unbound in ONE invocation: the aggregated
		// criticalWarn line must list only the first ten (map insertion order)
		// and disclose the exact remainder (PRR-006 boundary contract).
		const overflowIds = Array.from({ length: 12 }, (_, i) => `1.${i + 1}`);
		writePlan(tempDir, overflowIds);
		const session = ensureAgentSession(sessionID);
		for (const id of overflowIds) {
			session.taskWorkflowStates.set(id, 'reviewer_run');
		}
		session.currentTaskId = overflowIds[0];
		const hook = createDelegationGateHook(fullConfig(), tempDir);
		const criticalWarnSpy = spyOn(logger, 'criticalWarn').mockImplementation(
			() => {},
		);

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'call-2817-overflow',
				args: testEngineerArgs(),
			},
			{
				output: overflowIds
					.map((id) => `[TESTED] | task-${id} | PASS | ok`)
					.join('\n'),
			},
		);
		const dropLines = criticalWarnSpy.mock.calls
			.map((call) => String(call[0] ?? ''))
			.filter((line) => line.includes('Stage B settlement dropped'));
		criticalWarnSpy.mockRestore();

		expect(dropLines.length).toBe(1);
		expect(dropLines[0]).toContain('(+2 more)');
		// The first ten (insertion order 1.1..1.10) are listed; the last two
		// (1.11, 1.12) only via the overflow count. 1.10 in the listed set also
		// re-pins the prefix-collision fix at the host-log surface.
		for (const listed of overflowIds.slice(0, 10)) {
			expect(dropLines[0]).toContain(listed);
		}
		expect(dropLines[0]).not.toContain('1.11');
		expect(dropLines[0]).not.toContain('1.12');
	});

	it('re-advises on the next turn after the advisory queue drains', async () => {
		const sessionID = 'sess-2817-nextturn';
		tempDir = makeTempDir('dg-2817-nextturn-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'nextturn');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;
		const hook = createDelegationGateHook(fullConfig(), tempDir);
		const args = testEngineerArgs();

		await hook.toolAfter(
			{ tool: 'Task', sessionID, callID: 'call-2817-turn-1', args },
			{ output: `[TESTED] | task-${TASK_ID} | PASS | ok` },
		);
		expect(settlementDropAdvisories(sessionID).length).toBe(1);

		// Turn boundary: the guardrails drain clears the pending queue.
		session.pendingAdvisoryMessages = [];

		await hook.toolAfter(
			{ tool: 'Task', sessionID, callID: 'call-2817-turn-2', args },
			{ output: `[TESTED] | task-${TASK_ID} | PASS | ok` },
		);
		// The next turn's drop re-surfaces — no permanent suppression.
		expect(settlementDropAdvisories(sessionID).length).toBe(1);
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
		const criticalWarnSpy = spyOn(logger, 'criticalWarn').mockImplementation(
			() => {},
		);

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
		// Read the call log BEFORE mockRestore — restoring clears it.
		const happyPathDropLineEmitted = criticalWarnSpy.mock.calls
			.map((call) => String(call[0] ?? ''))
			.some((line) => line.includes('Stage B settlement dropped'));
		criticalWarnSpy.mockRestore();

		const session = ensureAgentSession(sessionID);
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('reviewer_run');
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.reviewer).toBeDefined();
		expect(session.stageBCompletion?.get(TASK_ID)?.has('reviewer')).toBe(true);
		// No drop advisory on the happy path...
		expect(settlementDropAdvisories(sessionID).length).toBe(0);
		// ...and no drop host-log line either (suppression, not just absence of
		// queue entries).
		expect(happyPathDropLineEmitted).toBe(false);
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
