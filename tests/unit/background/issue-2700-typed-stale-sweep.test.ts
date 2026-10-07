/**
 * Issue #2700 — the stale sweep settles a lane terminal WITH its typed
 * terminal evidence: the flip writes `terminalResult` (eventId identity,
 * 'liveness' class) atomically with `status: 'stale'`, so a swept lane is
 * never liveness-terminal without its typed result. A replay sweep must not
 * rewrite the event, and a pre-existing partial result keeps its evidence
 * under the merged class (the #2615 review-finding shape).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	appendDelegationTransition,
	type BackgroundDelegationResult,
	buildBackgroundCompletionEventId,
	findByCorrelationId,
	recordPendingDelegation,
	sweepStaleDelegations,
} from '../../../src/background/pending-delegations';
import { encodePrReviewWorkflowBinding } from '../../../src/background/pr-review-contract';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { dir, cleanup } = createSafeTestDir('swarm-bg-2700-sweep-');
afterEach(cleanup);
beforeEach(() => {
	fs.rmSync(path.join(dir, '.swarm'), { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

const HEAD = 'a'.repeat(40);
const INSTANCE = 'wf-2700-sweep';

async function seedLane(
	correlationId: string,
	jobId: string | null = encodePrReviewWorkflowBinding(INSTANCE),
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
			gitHead: HEAD,
			dirtyHash: null,
			prHeadSha: HEAD,
			scope: null,
		},
	});
}

describe('issue #2700: typed stale-sweep terminal evidence', () => {
	it('the sweep flip writes the typed terminal result atomically with the disposition', async () => {
		const id = 'ses_swept_typed';
		await seedLane(id);
		await new Promise((resolve) => setTimeout(resolve, 15));

		const swept = await sweepStaleDelegations(dir, 1);
		expect(swept).toBe(1);
		const record = findByCorrelationId(dir, id);
		expect(record?.status).toBe('stale');
		expect(record?.result?.workflowLaneFailureClass).toBe('liveness');
		const terminal = record?.terminalResult;
		expect(terminal).toBeDefined();
		expect(terminal?.status).toBe('stale');
		expect(terminal?.result.workflowLaneFailureClass).toBe('liveness');
		// Same identity material the claim path uses — replay-stable eventId.
		expect(terminal?.eventId).toBe(
			buildBackgroundCompletionEventId({
				correlationId: id,
				jobId: encodePrReviewWorkflowBinding(INSTANCE),
				status: 'stale',
				resultDigest: terminal?.result.digest,
			}),
		);
		expect(record?.completedAt).toBe(terminal?.recordedAt);
		expect(record?.schemaVersion).toBeGreaterThanOrEqual(3);
	});

	it('a replay sweep does not rewrite the typed event', async () => {
		const id = 'ses_swept_replay';
		await seedLane(id);
		await new Promise((resolve) => setTimeout(resolve, 15));
		await sweepStaleDelegations(dir, 1);
		const first = findByCorrelationId(dir, id);

		const reswept = await sweepStaleDelegations(dir, 1);
		expect(reswept).toBe(0);
		const second = findByCorrelationId(dir, id);
		expect(second?.terminalResult?.eventId).toBe(
			first?.terminalResult?.eventId,
		);
		expect(second?.updatedAt).toBe(first?.updatedAt);
	});

	it('a pre-existing partial result keeps its evidence under the merged liveness class', async () => {
		const id = 'ses_swept_merged';
		await seedLane(id);
		// Classless partial-transcript preview stamped before the flip (the
		// #2615 review-finding shape): distinct digest that must survive.
		const preview: BackgroundDelegationResult = {
			text: 'partial transcript preview',
			chars: 25,
			truncated: true,
			digest: createHash('sha256')
				.update('partial transcript preview')
				.digest('hex'),
		};
		await appendDelegationTransition(dir, id, {
			status: 'running',
			result: preview,
		});
		await new Promise((resolve) => setTimeout(resolve, 15));

		await sweepStaleDelegations(dir, 1);
		const record = findByCorrelationId(dir, id);
		expect(record?.status).toBe('stale');
		expect(record?.result?.digest).toBe(preview.digest);
		expect(record?.result?.workflowLaneFailureClass).toBe('liveness');
		expect(record?.terminalResult?.result.digest).toBe(preview.digest);
		expect(record?.terminalResult?.status).toBe('stale');
	});
});
