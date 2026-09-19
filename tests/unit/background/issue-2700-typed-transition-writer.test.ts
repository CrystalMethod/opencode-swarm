/**
 * Issue #2700 — the generic transition writer's typed-terminal support:
 * an explicit `terminalResult` is written atomically with a terminal flip;
 * a classed terminal transition (the #2615 producers' shape) DERIVES its
 * typed event when the caller passes none; a record that already carries a
 * typed event keeps it (never-overwrite); and a classless status-only
 * transition (the post-claim P1/P2 machinery shape) stays eventless.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	appendDelegationTransition,
	buildBackgroundCompletionEventId,
	buildTypedDelegationTerminal,
	claimTerminalResult,
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { encodePrReviewWorkflowBinding } from '../../../src/background/pr-review-contract';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { dir, cleanup } = createSafeTestDir('swarm-bg-2700-writer-');
afterEach(cleanup);
beforeEach(() => {
	fs.rmSync(path.join(dir, '.swarm'), { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

const JOB = encodePrReviewWorkflowBinding('wf-2700-writer');
const EMPTY_DIGEST = createHash('sha256').update('').digest('hex');

async function seed(correlationId: string): Promise<void> {
	await recordPendingDelegation(dir, {
		correlationId,
		jobId: JOB,
		subagentSessionId: correlationId,
		parentSessionId: 'ses_parent_2700',
		callID: `call-${correlationId}`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'batch-2700',
		laneId: 'lane-2700',
		mode: 'swarm-pr-review:base',
		workflowLane: 'compatibility-delivery',
		workflowGeneration: 1,
		generation: 1,
		workspace: {
			directory: dir,
			gitHead: 'a'.repeat(40),
			dirtyHash: null,
			prHeadSha: 'a'.repeat(40),
			scope: null,
		},
	});
}

function livenessResult(reason: string) {
	return {
		error: reason,
		chars: reason.length,
		truncated: false,
		digest: createHash('sha256').update(reason).digest('hex'),
		workflowLaneFailureClass: 'liveness' as const,
	};
}

describe('issue #2700: typed-terminal support in appendDelegationTransition', () => {
	it('derives the typed event for a classed terminal transition when none is passed', async () => {
		const id = 'ses_writer_derive';
		await seed(id);
		const reason =
			'lane lane-2700 presumed stale: idle host session past the stale horizon';
		const flipped = await appendDelegationTransition(dir, id, {
			status: 'stale',
			result: livenessResult(reason),
			expectedCurrentStatuses: ['pending', 'running', 'ingestion_error'],
		});
		expect(flipped?.status).toBe('stale');
		const terminal = flipped?.terminalResult;
		expect(terminal?.status).toBe('stale');
		expect(terminal?.result.workflowLaneFailureClass).toBe('liveness');
		expect(terminal?.eventId).toBe(
			buildBackgroundCompletionEventId({
				correlationId: id,
				jobId: JOB,
				status: 'stale',
				resultDigest: terminal?.result.digest,
			}),
		);
		expect(terminal?.recordedAt).toBe(flipped?.updatedAt);
		expect(findByCorrelationId(dir, id)?.terminalResult?.eventId).toBe(
			terminal?.eventId,
		);
	});

	it('writes an explicitly provided terminalResult with the flip', async () => {
		const id = 'ses_writer_explicit';
		await seed(id);
		const result = livenessResult(
			'lane cancelled via collect_lane_results cancel_pending',
		);
		const explicit = buildTypedDelegationTerminal(
			{ correlationId: id, jobId: JOB },
			'cancelled',
			result,
			1_800_000_000_000,
		);
		const flipped = await appendDelegationTransition(dir, id, {
			status: 'cancelled',
			result,
			terminalResult: explicit,
			updatedAt: 1_800_000_000_000,
		});
		expect(flipped?.terminalResult).toEqual(explicit);
		expect(flipped?.completedAt).toBe(explicit.recordedAt);
	});

	it('never overwrites an existing typed event on a later transition', async () => {
		const id = 'ses_writer_keep';
		await seed(id);
		const text = 'completed lane output';
		const claimed = await claimTerminalResult(dir, id, {
			eventId: buildBackgroundCompletionEventId({
				correlationId: id,
				jobId: JOB,
				status: 'completed',
				resultDigest: createHash('sha256').update(text).digest('hex'),
			}),
			status: 'completed',
			recordedAt: Date.now(),
			result: {
				text,
				chars: text.length,
				truncated: false,
				digest: createHash('sha256').update(text).digest('hex'),
			},
		});
		expect(claimed?.disposition).toBe('claimed');
		const originalEventId = claimed?.record.terminalResult?.eventId;

		// The completed→stale machinery exception admits the flip; the original
		// typed event must survive it.
		const flipped = await appendDelegationTransition(dir, id, {
			status: 'stale',
			result: livenessResult('post-claim staleness'),
		});
		expect(flipped?.status).toBe('stale');
		expect(flipped?.terminalResult?.eventId).toBe(originalEventId);
	});

	it('a classless status-only transition stays eventless (the P1/P2 shape)', async () => {
		const id = 'ses_writer_classless';
		await seed(id);
		const flipped = await appendDelegationTransition(dir, id, {
			status: 'stale',
		});
		expect(flipped?.status).toBe('stale');
		expect(flipped?.terminalResult).toBeUndefined();
	});
});
