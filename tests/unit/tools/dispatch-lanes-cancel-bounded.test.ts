/**
 * #2971 bounded cancel/collect surfaces, extracted to their own file so the
 * host-timeout and dispatch-lanes suites stay under the FR-006 500-line cap.
 * Pins, unchanged from their original homes:
 *  - collect_lane_results answers cancel_pending with typed refusal guidance
 *    (observation-only: nothing aborted or settled; the no-messages-client
 *    harness also carries the #2381 no_client observer diagnostic),
 *  - a hung session.abort under a CONFIRMED cancel_lane_batch cancellation
 *    never claims cancellation: the lane stays pending and the timeout is
 *    reported in errors[].
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { findByBatchId } from '../../../src/background/pending-delegations';
import {
	_internals as cancelInternals,
	executeCancelLaneBatch,
} from '../../../src/tools/cancel-lane-batch';
import {
	_internals,
	executeCollectLaneResults,
	executeDispatchLanesAsync,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes';
import { createCollectLaneTimeoutFixture } from './dispatch-lanes-collect-host-timeout.fixtures';

const {
	baseOps,
	cleanupTempDirs,
	makeTempDir,
	recordPending,
	restoreInternals,
	withTestDeadline,
} = createCollectLaneTimeoutFixture();

const realCancelOps = cancelInternals.getSessionOps;
const realAbortBudgetMs = cancelInternals.abortBudgetMs;

afterEach(() => {
	restoreInternals();
	cancelInternals.getSessionOps = realCancelOps;
	cancelInternals.abortBudgetMs = realAbortBudgetMs;
	cleanupTempDirs();
});

describe('#2971 bounded cancel/collect surfaces', () => {
	test('answers cancel_pending with typed refusal guidance (observation-only)', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-cancel' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			messages: mock(async () => ({ data: null, error: undefined })),
			abort: mock(async () => undefined),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		await executeDispatchLanesAsync(
			{
				batch_id: 'batch-cancel',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
		);
		const result = await executeCollectLaneResults(
			{ batch_id: 'batch-cancel', cancel_pending: true },
			directory,
		);

		// The collector is observation-only: cancel_pending is answered with
		// typed refusal guidance and nothing is aborted or settled. This
		// harness has no messages client, so the response also carries the
		// #2381 no_client observer diagnostic.
		expect(result.success).toBe(false);
		expect(result.cancelled).toBe(0);
		expect(result.pending).toBe(1);
		expect(result.cancellation_refused).toHaveLength(1);
		expect(result.cancellation_refused?.[0]?.next_action).toContain(
			'cancel_lane_batch',
		);
	});

	test('bounds a hung session.abort call on the confirmed cancel surface without claiming cancellation (issue #2971)', async () => {
		const directory = makeTempDir();
		const batchId = 'hung-abort';
		await recordPending({ directory, batchId });
		const abort = mock(() => new Promise<never>(() => {}));
		// The collector is observation-only post-#2971, so the bounded-abort
		// contract lives on cancel_lane_batch: a hung session.abort under a
		// CONFIRMED cancellation must never claim cancellation — the lane is
		// left pending and the abort timeout is reported in errors[].
		cancelInternals.abortBudgetMs = 25;
		cancelInternals.getSessionOps = () =>
			({
				...baseOps(),
				abort,
				status: mock(async () => ({
					data: { [`${batchId}-session`]: { type: 'idle' } },
					error: undefined,
				})),
			}) as never;

		const result = await withTestDeadline(
			executeCancelLaneBatch(
				{
					batch_id: batchId,
					reason: 'hung-abort probe',
					confirm: true,
				},
				directory,
			),
		);
		expect(result.cancelled).toBe(0);
		expect(result.errors.join('; ')).toContain('session.abort');
		const record = findByBatchId(directory, batchId)[0];
		expect(record.status).toBe('pending');
		expect(abort).toHaveBeenCalledTimes(1);
	});
});
