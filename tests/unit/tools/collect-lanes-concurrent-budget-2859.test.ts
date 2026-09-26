import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { recordPendingDelegation } from '../../../src/background/pending-delegations.js';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { _test_exports as gateInternals } from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	_test_exports,
	executeCollectLaneResults,
} from '../../../src/tools/dispatch-lanes.js';
import { backdatePrWorkflowLane } from '../../helpers/pr-workflow-lane-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #2859 (F5): the collect record refresh previously ran SEQUENTIALLY
 * against one absolute deadline, so slow early host calls starved later lanes
 * (and the pending-liveness probe degraded to probe-skipped-no-budget while
 * completed lanes looked "running" for minutes). The refresh now runs
 * bound-concurrent with a floored per-lane budget clamped to the caller's
 * total deadline, and a starved probe surfaces in the top-level message.
 */

const originalSessionOps = _internals.getSessionOps;
const originalNow = _internals.now;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let directory = '';
let statusCalls = 0;
let statusDelayMs = 0;
let statusNeverResolves = false;

function installSession(): void {
	statusCalls = 0;
	_internals.getSessionOps = () => ({
		status: async () => {
			statusCalls += 1;
			if (statusNeverResolves) await sleep(60_000);
			await sleep(statusDelayMs);
			// Empty status map: readiness is never 'busy', so the messages
			// fetch runs too and the lane stays pending (no terminal proof).
			return { data: {} };
		},
		messages: async () => ({ data: [] }),
	});
}

async function recordLanes(count: number): Promise<void> {
	for (let index = 1; index <= count; index++) {
		const correlationId = `child-2859-${index}`;
		const outcome = await recordPendingDelegation(directory, {
			correlationId,
			jobId: null,
			subagentSessionId: correlationId,
			parentSessionId: 'collect-parent-2859',
			callID: `call-${index}`,
			normalizedAgent: 'swarm_explorer',
			swarmPrefixedAgent: 'swarm_explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'batch-2859',
			laneId: `lane-2859-${index}`,
			mode: 'swarm-pr-review:critic',
			workflowLane: 'critic-family',
			workspace: {
				directory,
				gitHead: 'abc123',
				dirtyHash: null,
				prHeadSha: 'abc123',
				scope: null,
			},
		});
		// recordPendingDelegation returns the written record; its delegation
		// status is 'pending' when the write landed (fail-open returns null-ish).
		expect((outcome as { status?: string } | null)?.status).toBe('pending');
	}
}

beforeEach(() => {
	directory = canonicalMkdtemp('sw2859-f5-');
	mkdirSync(join(directory, '.git'), { recursive: true });
	statusDelayMs = 0;
	statusNeverResolves = false;
	installSession();
	gateInternals.resetTrackedStateCache();
	gateInternals.pendingLaneLivenessThresholdMs = 60_000;
});

afterEach(() => {
	_internals.getSessionOps = originalSessionOps;
	_internals.now = originalNow;
	gateInternals.resetTrackedStateCache();
	closeProjectDb(directory);
});

describe('reserveConcurrentLaneCallBudgets floor math (issue #2859 F5)', () => {
	afterEach(() => {
		_internals.now = originalNow;
	});

	test('the per-lane share carries a 1s floor, clamped by the remaining budget', () => {
		const fakeNow = 10_000;
		_internals.now = () => fakeNow;
		const reserve = _test_exports.reserveConcurrentLaneCallBudgets;

		// remaining 3000, 6 lanes: naive share 500, floor lifts to 1000.
		const floored = reserve(13_000, 6, true);
		expect(floored.laneBudgetMs).toBe(1000);
		expect(floored.statusBudgetMs).toBeGreaterThan(0);
		expect(floored.statusBudgetMs).toBeLessThanOrEqual(floored.laneBudgetMs);
		expect(
			floored.statusBudgetMs +
				floored.messagesBudgetMs +
				floored.revisionDigestBudgetMs,
		).toBeLessThanOrEqual(floored.laneBudgetMs + floored.statusBudgetMs); // split never exceeds the share + its own terms

		// remaining 500, 6 lanes: the floor can NEVER exceed the total deadline.
		const capped = reserve(10_500, 6, true);
		expect(capped.laneBudgetMs).toBe(500);

		// remaining 0: everything is zero (withCollectionDeadline hard cap).
		const zero = reserve(10_000, 6, true);
		expect(zero.laneBudgetMs).toBe(0);
		expect(zero.statusBudgetMs).toBe(0);
		expect(zero.messagesBudgetMs).toBe(0);

		// PR #2863 review (BOT-3): remaining BELOW the floor with laneCount
		// above the concurrency cap — the floor must clamp to the remaining
		// budget, never exceed it.
		const tiny = reserve(10_900, 12, true);
		expect(tiny.laneBudgetMs).toBe(900);
		expect(tiny.statusBudgetMs).toBeGreaterThan(0);
		expect(tiny.statusBudgetMs).toBeLessThanOrEqual(900);
	});
});

describe('collect_lane_results concurrent record refresh — regression: sequential starvation (F5)', () => {
	test('all lanes get their probe attempt and the refresh wall-clock is the max, not the sum', async () => {
		// PR #2863 review (PRR-004): the discriminator must be STRUCTURAL, not
		// timing-only. 6 lanes x 300ms host latency under a 1600ms budget: a
		// SEQUENTIAL refresh needs 6*300=1800ms > 1600ms, so the last lane(s)
		// hit a zero/under-budget probe and are skipped — the SEQUENTIAL
		// wall-clock alone (>= 1600ms) violates the elapsedMs bound below,
		// while the CONCURRENT refresh costs ~600ms and completes all lanes.
		// Issue #2971: the per-lane status round-trip is gone — ONE batched
		// host-wide probe covers all 6 lanes, and the per-lane concurrency now
		// rides the messages fetches (still discriminated by elapsedMs).
		// statusCalls counts INVOCATIONS (the mock increments synchronously),
		// so it is 1 per pass and is asserted only as a "the pass probed the
		// batch" sanity pin, not as the discriminator.
		statusDelayMs = 300;
		await recordLanes(6);
		const startedAt = performance.now();
		const result = (await executeCollectLaneResults(
			{ batch_id: 'batch-2859', wait: false, timeout_ms: 1600 },
			directory,
		)) as { pending?: number };
		const elapsedMs = performance.now() - startedAt;
		expect(result.pending).toBeGreaterThan(0);
		expect(statusCalls).toBe(1);
		// Load-bearing discriminator: a sequential refresh (>= 1600ms of
		// status work alone) exceeds this bound; the concurrent fan-out
		// finishes in ~600ms with 2.5x margin.
		expect(elapsedMs).toBeLessThan(1500);
	}, 20_000);

	test('a starved pending-liveness probe surfaces in the top-level message', async () => {
		// Never-resolving host calls exhaust the total budget; the
		// pending-liveness probe is then skipped for budget and the
		// top-level message must say so (previously visible only inside
		// pending_liveness[].degradedReason).
		// timeout_ms: 0 is a valid immediate snapshot (issue #2381): the
		// total wait budget is already exhausted, every per-lane budget is
		// zero, and the pending-liveness probe must be SKIPPED for budget —
		// deterministically, with no timers involved.
		statusNeverResolves = true;
		await recordLanes(3);
		// pending_liveness entries only exist for lanes past the
		// 60s liveness threshold — backdate all three by 5 minutes.
		for (let index = 1; index <= 3; index++) {
			await backdatePrWorkflowLane(directory, `child-2859-${index}`, 300_000);
		}
		const result = (await executeCollectLaneResults(
			{ batch_id: 'batch-2859', wait: false, timeout_ms: 0 },
			directory,
		)) as {
			message?: string;
			pending_liveness?: Array<{ degradedReason?: string }>;
		};
		const starved = (result.pending_liveness ?? []).filter(
			(lane) => lane.degradedReason === 'probe-skipped-no-budget',
		);
		// Deterministic core: the never-resolving host calls exhaust the
		// 400ms budget, so the probe is starved AND the top-level message
		// must carry the sentence.
		expect(starved.length).toBeGreaterThan(0);
		expect(result.message).toContain(
			'pending-liveness probe(s) skipped for budget',
		);
		expect(result.message).toContain('probe-skipped-no-budget');
		expect(result.message).toContain(
			'lanes may be further settled than reported',
		);
	}, 20_000);
});
