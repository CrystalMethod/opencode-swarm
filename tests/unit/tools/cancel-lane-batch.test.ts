/**
 * cancel_lane_batch (issue #2971) — the confirmed-cancellation tool contract.
 *
 * The collector is observation-only; this is the ONLY model-facing destructive
 * cancellation surface for dispatch_lanes_async batches. These tests pin:
 *  - the liveness preflight (busy/retry refused; degraded probe refuses the
 *    whole batch fail-closed; absent-from-successful-map / idle may proceed),
 *  - the per-lane race safety (abort timeout never claims cancellation; a
 *    child completing inside the abort window wins and is preserved),
 *  - the exactly-once operator_cancelled terminal claim (never liveness),
 *  - the authorization boundary (confirm + bounded reason + known batch).
 *
 * Hosts are scripted through the production `_internals.getSessionOps` DI seam
 * (the dispatch-lanes pattern); no mock.module. The clock is pinned through
 * `_internals.now` (fixed epoch — no raw clock reads in this file).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { settleDelegationTerminal } from '../../../src/background/delegation-lifecycle.js';
import {
	appendDelegationTransition,
	findByBatchId,
	findByCorrelationIdDetailed,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	_internals,
	executeCancelLaneBatch,
} from '../../../src/tools/cancel-lane-batch.js';
import type { SessionOps } from '../../../src/tools/dispatch-lanes.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const EMPTY_DIGEST = createHash('sha256').update('').digest('hex');
/** Pinned epoch (no raw clock reads in this file; check-test-clock clean). */
const FIXED_EPOCH = 1_700_000_000_000;

const realGetSessionOps = _internals.getSessionOps;
const realNow = _internals.now;
const realAbortBudgetMs = _internals.abortBudgetMs;

let dir = '';

/** Idle host whose status map the caller fully controls. */
function scriptHost(statusMap: Record<string, { type?: string }>): {
	ops: SessionOps;
	abort: ReturnType<typeof mock>;
	status: ReturnType<typeof mock>;
} {
	const abort = mock(async () => undefined);
	const status = mock(async () => ({ data: statusMap, error: undefined }));
	const ops = {
		create: async () => ({ data: { id: 'unused' }, error: undefined }),
		prompt: async () => ({ data: null, error: undefined }),
		promptAsync: async () => ({ data: undefined, error: undefined }),
		status,
		messages: async () => ({ data: [], error: undefined }),
		delete: async () => undefined,
		abort,
	} as unknown as SessionOps;
	return { ops, abort, status };
}

async function seedPendingLane(
	batchId: string,
	suffix: string,
): Promise<{ correlationId: string; laneId: string }> {
	const correlationId = `sess-clb-${suffix}`;
	const laneId = `lane-clb-${suffix}`;
	const recorded = await recordPendingDelegation(dir, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: `parent-clb-${suffix}`,
		callID: batchId,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId,
		mode: 'advisory',
		promptHash: `${batchId}-hash`,
		generation: 1,
	});
	expect(recorded).not.toBeNull();
	return { correlationId, laneId };
}

function confirmedArgs(batchId: string, reason = 'operator test reason') {
	return { batch_id: batchId, reason, confirm: true };
}

describe('cancel_lane_batch (issue #2971)', () => {
	beforeEach(() => {
		dir = canonicalMkdtemp('cancel-lane-batch-');
		_internals.now = () => FIXED_EPOCH;
	});
	afterEach(() => {
		_internals.getSessionOps = realGetSessionOps;
		_internals.now = realNow;
		_internals.abortBudgetMs = realAbortBudgetMs;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('busy and retry lanes are refused; live work is never aborted here', async () => {
		const busy = await seedPendingLane('batch-live', 'busy');
		const retry = await seedPendingLane('batch-live', 'retry');
		const { ops, abort } = scriptHost({
			[busy.correlationId]: { type: 'busy' },
			[retry.correlationId]: { type: 'retry' },
		});
		_internals.getSessionOps = () => ops;
		const result = await executeCancelLaneBatch(
			confirmedArgs('batch-live'),
			dir,
		);
		expect(result.success).toBe(true);
		expect(result.cancelled).toBe(0);
		expect(result.refused).toHaveLength(2);
		const busyRefusal = result.refused.find(
			(entry) => entry.lane_id === busy.laneId,
		);
		const retryRefusal = result.refused.find(
			(entry) => entry.lane_id === retry.laneId,
		);
		expect(busyRefusal?.host_status).toBe('busy');
		expect(retryRefusal?.host_status).toBe('retry');
		for (const refusal of result.refused) {
			expect(refusal.next_action).toContain('abort-pr-workflow');
		}
		expect(abort).not.toHaveBeenCalled();
		for (const lane of [busy, retry]) {
			const record = findByBatchId(dir, 'batch-live').find(
				(entry) => entry.laneId === lane.laneId,
			);
			expect(record?.status).toBe('pending');
		}
	});

	test('an idle lane cancels exactly once with the operator_cancelled class', async () => {
		const lane = await seedPendingLane('batch-idle', '1');
		const { ops, abort } = scriptHost({
			[lane.correlationId]: { type: 'idle' },
		});
		_internals.getSessionOps = () => ops;
		const result = await executeCancelLaneBatch(
			confirmedArgs('batch-idle'),
			dir,
		);
		expect(result.cancelled).toBe(1);
		expect(abort).toHaveBeenCalledTimes(1);
		expect((abort.mock.calls[0]?.[0] as { path: { id: string } }).path.id).toBe(
			lane.correlationId,
		);
		const record = findByBatchId(dir, 'batch-idle')[0];
		expect(record.status).toBe('cancelled');
		expect(record.terminalResult?.result?.workflowLaneFailureClass).toBe(
			'operator_cancelled',
		);
		expect(record.terminalResult?.result?.error).toMatch(/cancel_lane_batch/);
		expect(record.terminalResult?.result?.digest).toBe(EMPTY_DIGEST);
	});

	test('a session absent from a successful (empty) status map may proceed — orphan path', async () => {
		const lane = await seedPendingLane('batch-orphan', '1');
		const { ops, abort } = scriptHost({});
		_internals.getSessionOps = () => ops;
		const result = await executeCancelLaneBatch(
			confirmedArgs('batch-orphan'),
			dir,
		);
		expect(result.cancelled).toBe(1);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(findByBatchId(dir, 'batch-orphan')[0]?.status).toBe('cancelled');
	});

	test('a degraded liveness probe refuses the whole batch fail-closed (no abort)', async () => {
		const cases: Array<{
			name: string;
			host: () => { ops: SessionOps; abort: ReturnType<typeof mock> };
			reason: string;
		}> = [
			{
				name: 'status throws',
				host: () => {
					const host = scriptHost({});
					host.ops.status = (async () => {
						throw new Error('host status exploded');
					}) as unknown as SessionOps['status'];
					return host;
				},
				reason: 'probe-error',
			},
			{
				name: 'status returns an error envelope',
				host: () => {
					const host = scriptHost({});
					host.ops.status = (async () => ({
						data: undefined,
						error: { code: 'internal' },
					})) as unknown as SessionOps['status'];
					return host;
				},
				reason: 'probe-no-data',
			},
			{
				name: 'status returns no data',
				host: () => {
					const host = scriptHost({});
					host.ops.status = (async () => ({
						data: null,
						error: undefined,
					})) as unknown as SessionOps['status'];
					return host;
				},
				reason: 'probe-no-data',
			},
			{
				name: 'no status function on the host',
				host: () => {
					const host = scriptHost({});
					delete (host.ops as { status?: unknown }).status;
					return host;
				},
				reason: 'probe-unavailable',
			},
		];
		for (const [index, testCase] of cases.entries()) {
			const batchId = `batch-degraded-${index}`;
			await seedPendingLane(batchId, `${index}`);
			const { ops, abort } = testCase.host();
			_internals.getSessionOps = () => ops;
			const result = await executeCancelLaneBatch(confirmedArgs(batchId), dir);
			expect(result.cancelled).toBe(0);
			expect(result.refused).toHaveLength(1);
			expect(result.refused[0]?.degraded_reason).toBe(testCase.reason);
			expect(result.refused[0]?.next_action).toContain('observer degraded');
			expect(abort).not.toHaveBeenCalled();
			expect(findByBatchId(dir, batchId)[0]?.status).toBe('pending');
		}
	});

	test('an abort timeout never claims cancellation — the lane stays pending', async () => {
		const lane = await seedPendingLane('batch-timeout', '1');
		const { ops, abort } = scriptHost({
			[lane.correlationId]: { type: 'idle' },
		});
		// A never-resolving abort request: only the bounded budget ends the race.
		abort.mockImplementation(() => new Promise(() => {}));
		_internals.abortBudgetMs = 25;
		_internals.getSessionOps = () => ops;
		try {
			const result = await executeCancelLaneBatch(
				confirmedArgs('batch-timeout'),
				dir,
			);
			expect(result.cancelled).toBe(0);
			expect(
				result.errors.some((entry) => entry.includes('session.abort')),
			).toBe(true);
			expect(findByBatchId(dir, 'batch-timeout')[0]?.status).toBe('pending');
		} finally {
			_internals.abortBudgetMs = realAbortBudgetMs;
		}
	});

	test('the authorization boundary rejects malformed or unknown requests before any abort', async () => {
		const lane = await seedPendingLane('batch-args', '1');
		const { ops, abort } = scriptHost({
			[lane.correlationId]: { type: 'idle' },
		});
		_internals.getSessionOps = () => ops;
		const invalid: Array<[string, Record<string, unknown>]> = [
			['missing confirm', { batch_id: 'batch-args', reason: 'why' }],
			[
				'confirm false',
				{ batch_id: 'batch-args', reason: 'why', confirm: false },
			],
			[
				'empty reason',
				{ batch_id: 'batch-args', reason: '   ', confirm: true },
			],
			[
				'oversized reason',
				{ batch_id: 'batch-args', reason: 'x'.repeat(201), confirm: true },
			],
		];
		for (const [name, args] of invalid) {
			const result = await executeCancelLaneBatch(args, dir);
			expect(result.success).toBe(false);
			expect(result.failure_class).toBe('invalid_args');
			expect(result.cancelled).toBe(0);
		}
		const unknownBatch = await executeCancelLaneBatch(
			confirmedArgs('batch-does-not-exist'),
			dir,
		);
		expect(unknownBatch.success).toBe(false);
		expect(unknownBatch.failure_class).toBe('not_found');
		expect(abort).not.toHaveBeenCalled();
		expect(findByBatchId(dir, 'batch-args')[0]?.status).toBe('pending');
	});

	test('double cancel: the exactly-once claim answers already_settled on the replay', async () => {
		const lane = await seedPendingLane('batch-once', '1');
		const { ops, abort } = scriptHost({
			[lane.correlationId]: { type: 'idle' },
		});
		_internals.getSessionOps = () => ops;
		const first = await executeCancelLaneBatch(
			confirmedArgs('batch-once'),
			dir,
		);
		expect(first.cancelled).toBe(1);
		const record = findByBatchId(dir, 'batch-once')[0];
		const firstTerminal = record.terminalResult;
		const second = await executeCancelLaneBatch(
			confirmedArgs('batch-once'),
			dir,
		);
		expect(second.cancelled).toBe(0);
		// The batch snapshot filters terminal records up front, so a fully
		// settled replay reports zero ACTIVE lanes; the unchanged terminal is
		// the exactly-once proof.
		expect(second.total_active).toBe(0);
		expect(second.message).toContain('no active');
		expect(abort).toHaveBeenCalledTimes(1);
		const reread = findByBatchId(dir, 'batch-once')[0];
		expect(reread.status).toBe('cancelled');
		// The terminal is unchanged — no second claim, no class flip.
		expect(reread.terminalResult).toEqual(firstTerminal);
	});

	test('completion race: a child finishing inside the abort window wins and is preserved', async () => {
		const lane = await seedPendingLane('batch-race', '1');
		const { ops, abort } = scriptHost({
			[lane.correlationId]: { type: 'idle' },
		});
		const raceText = 'child finished before the abort landed';
		// The abort hook settles the record COMPLETED before returning — the
		// post-abort re-read must preserve that terminal, never overwrite it.
		abort.mockImplementation(async () => {
			const read = findByCorrelationIdDetailed(dir, lane.correlationId);
			expect(read.status).toBe('ok');
			expect(read.value).not.toBeNull();
			await settleDelegationTerminal(
				dir,
				read.value!,
				{
					status: 'completed',
					result: {
						text: raceText,
						chars: raceText.length,
						truncated: false,
						digest: createHash('sha256').update(raceText).digest('hex'),
					},
				},
				{},
				FIXED_EPOCH,
			);
		});
		_internals.getSessionOps = () => ops;
		const result = await executeCancelLaneBatch(
			confirmedArgs('batch-race'),
			dir,
		);
		expect(result.cancelled).toBe(0);
		expect(result.preserved_completions).toContain(lane.laneId);
		expect(result.already_settled).not.toContain(lane.laneId);
		const record = findByBatchId(dir, 'batch-race')[0];
		expect(record.status).toBe('completed');
		expect(record.terminalResult?.result?.text).toBe(raceText);
		expect(
			record.terminalResult?.result?.workflowLaneFailureClass,
		).toBeUndefined();
	});

	test('legacy compatibility: a liveness-class cancelled terminal stays readable', async () => {
		const lane = await seedPendingLane('batch-legacy', '1');
		// Pre-#2971 cancel shape: status cancelled with a typed 'liveness'
		// class written through the generic transition writer. The store must
		// keep reading it back — read-side compatibility, not a producer.
		await appendDelegationTransition(dir, lane.correlationId, {
			status: 'cancelled',
			result: {
				error: 'lane cancelled via collect_lane_results cancel_pending',
				chars: 0,
				truncated: false,
				digest: EMPTY_DIGEST,
				workflowLaneFailureClass: 'liveness',
			},
		});
		const records = findByBatchId(dir, 'batch-legacy');
		expect(records).toHaveLength(1);
		expect(records[0]?.status).toBe('cancelled');
		expect(records[0]?.result?.workflowLaneFailureClass).toBe('liveness');
	});
});
