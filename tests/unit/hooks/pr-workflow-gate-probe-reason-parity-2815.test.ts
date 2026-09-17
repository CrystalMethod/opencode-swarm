/**
 * Issue #2815 — probe-reason parity for the pending-liveness advisory.
 *
 * One string must never carry two disjoint causes: `'probe-timeout'` means a
 * probe RAN against the host and hit its internal deadline; a probe that was
 * never attempted because the caller's probe budget was already exhausted is
 * `'probe-skipped-no-budget'` — an observer-side budget artifact that carries
 * no information about the child sessions. The 2026-09-16 incident in the
 * issue happened precisely because the two conditions shared the
 * `'probe-timeout'` label and an orchestrator cancelled live lanes on it.
 *
 * These pins are purely BEHAVIORAL: the never-attempted-maps-to-timeout source
 * contract is owned by the frozen C3 statics of the issue-tracer trace, not
 * duplicated here.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import type { BackgroundDelegationRecord } from '../../../src/background/pending-delegations.js';
import {
	collectPrWorkflowPendingLaneLiveness,
	_test_exports as gateInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const FIVE_MINUTES_MS = 300_000;

let directory = '';
let restoreClock: () => void = () => {};
let statusCalls = 0;

function unitRecord(laneId: string): BackgroundDelegationRecord {
	return {
		schemaVersion: 3,
		correlationId: `corr-${laneId}`,
		jobId: null,
		subagentSessionId: `sub-${laneId}`,
		parentSessionId: 'parent-session',
		callID: `call-${laneId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		status: 'pending',
		createdAt: -FIVE_MINUTES_MS,
		updatedAt: -FIVE_MINUTES_MS,
		batchId: 'batch-1',
		laneId,
		mode: 'swarm-pr-review:critic',
	};
}

beforeEach(() => {
	restoreClock = freezeClock();
	directory = canonicalMkdtemp('pr-probe-reason-parity-');
	gateInternals.resetTrackedStateCache();
	gateInternals.pendingLaneLivenessThresholdMs = 60_000;
});

afterEach(async () => {
	restoreClock();
	gateInternals.resetTrackedStateCache();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('probe-reason parity (issue #2815)', () => {
	test('zero caller probe budget: no probe attempted, reason names the skip', async () => {
		statusCalls = 0;
		gateInternals.getSessionOps = () => ({
			status: async () => {
				statusCalls += 1;
				return { data: { 'sub-critic-1': { type: 'busy' } } };
			},
		});

		const advisories = await collectPrWorkflowPendingLaneLiveness(
			directory,
			[unitRecord('critic-1')],
			{ probeBudgetMs: 0 },
		);

		expect(statusCalls).toBe(0);
		expect(advisories).toEqual([
			{
				laneId: 'critic-1',
				pendingMs: FIVE_MINUTES_MS,
				hostStatus: 'unknown',
				stalledSuspect: true,
				degradedReason: 'probe-skipped-no-budget',
			},
		]);
	});

	test('a probe that runs and outlives its deadline keeps probe-timeout', async () => {
		// `freezeClock` patches Date.now, NOT setTimeout, so the honest way to
		// reach the real-timeout branch is to shorten the deadline through its
		// seam and let a genuinely-late status call lose the race.
		statusCalls = 0;
		gateInternals.laneLivenessProbeTimeoutMs = 5;
		gateInternals.getSessionOps = () => ({
			status: () => {
				statusCalls += 1;
				return new Promise((resolve) => {
					setTimeout(() => resolve({ data: {} }), 250);
				});
			},
		});

		const advisories = await collectPrWorkflowPendingLaneLiveness(
			directory,
			[unitRecord('critic-1')],
			{ probeBudgetMs: 60_000 },
		);

		expect(statusCalls).toBe(1);
		expect(advisories).toEqual([
			{
				laneId: 'critic-1',
				pendingMs: FIVE_MINUTES_MS,
				hostStatus: 'unknown',
				stalledSuspect: true,
				degradedReason: 'probe-timeout',
			},
		]);
	});
});
