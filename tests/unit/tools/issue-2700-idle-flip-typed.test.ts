/**
 * Issue #2700 — the dispatch-lanes abandonment call shapes settle typed:
 * the idle-host stale flip (dispatch-lanes "idle host session past the stale
 * horizon" branch) and the launch-error bare transition ("Record never
 * landed" branch) both pass their explicit typed terminal through the
 * production transition writer, so neither producer can leave an eventless
 * terminal record. The writer itself is the changed surface; these tests pin
 * the exact call-site shapes against it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	appendDelegationTransition,
	buildBackgroundCompletionEventId,
	buildTypedDelegationTerminal,
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { encodePrReviewWorkflowBinding } from '../../../src/background/pr-review-contract';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { dir, cleanup } = createSafeTestDir('swarm-tools-2700-idle-');
afterEach(cleanup);
beforeEach(() => {
	fs.rmSync(path.join(dir, '.swarm'), { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

const JOB = encodePrReviewWorkflowBinding('wf-2700-idle');

async function seed(
	correlationId: string,
	jobId: string | null = JOB,
): Promise<void> {
	await recordPendingDelegation(dir, {
		correlationId,
		jobId,
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

describe('issue #2700: dispatch-lanes abandonment shapes settle typed', () => {
	it('the idle-host stale flip leaves a typed terminal record', async () => {
		const id = 'ses_idle_flip';
		await seed(id);
		const idleStaleReason = `lane lane-2700 presumed stale: idle host session past the stale horizon`;
		const idleLivenessResult = {
			error: idleStaleReason,
			chars: idleStaleReason.length,
			truncated: false,
			digest: createHash('sha256').update(idleStaleReason).digest('hex'),
			workflowLaneFailureClass: 'liveness' as const,
		};
		const idleTerminal = buildTypedDelegationTerminal(
			// currentAfterReadiness at the call site
			findByCorrelationId(dir, id)!,
			'stale',
			idleLivenessResult,
			Date.now(),
		);
		const flipped = await appendDelegationTransition(dir, id, {
			status: 'stale',
			result: idleLivenessResult,
			expectedCurrentStatuses: ['pending', 'running', 'ingestion_error'],
			terminalResult: idleTerminal,
		});
		expect(flipped?.status).toBe('stale');
		expect(flipped?.terminalResult?.eventId).toBe(idleTerminal.eventId);
		expect(flipped?.terminalResult?.result.workflowLaneFailureClass).toBe(
			'liveness',
		);
	});

	it('the launch-error bare transition carries its typed terminal (jobId unknown)', async () => {
		const id = 'ses_launch_error_partial';
		// Partial-landing race: the start record exists, so the bare-transition
		// branch's write lands on a real record with null jobId identity.
		await seed(id, null);
		const message = 'session.promptAsync launch failed: host rejected';
		const launchErrorResult = {
			error: message,
			chars: message.length,
			truncated: false,
			digest: createHash('sha256').update(message).digest('hex'),
			workflowLaneFailureClass: 'resource' as const,
		};
		const flipped = await appendDelegationTransition(dir, id, {
			status: 'error',
			result: launchErrorResult,
			terminalResult: buildTypedDelegationTerminal(
				{ correlationId: id, jobId: null },
				'error',
				launchErrorResult,
				Date.now(),
			),
		});
		expect(flipped?.status).toBe('error');
		const terminal = flipped?.terminalResult;
		expect(terminal?.status).toBe('error');
		expect(terminal?.result.workflowLaneFailureClass).toBe('resource');
		expect(terminal?.eventId).toBe(
			buildBackgroundCompletionEventId({
				correlationId: id,
				jobId: null,
				status: 'error',
				resultDigest: launchErrorResult.digest,
			}),
		);
	});
});
