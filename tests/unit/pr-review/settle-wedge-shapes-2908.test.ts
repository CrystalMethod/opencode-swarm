/**
 * Settlement wedge-shape reproductions (issue #2908, AC4) — one hand-written
 * reproduction per historical incident, per the wedge-shape layer map in
 * docs/pr-review-transition-authority.md. Shapes #2214 (ledger layer; the
 * DISPATCHED-WAL surface itself is pinned by
 * tests/unit/workflow/coder-settlement-2214.test.ts), #2402/#2666 (reducer
 * fence + the load-bearing publisher expectedWorkflowRevision fence),
 * #2840 (reducer verdict matrix, fix PR #2880), and #2829 (ledger refold +
 * the stage-b binding store, fix PR #2883 — fail-closed consumer:
 * warnStageBSettlementDropped, src/hooks/delegation-gate.ts:3603-3641, drop
 * sites :6740/:6798/:6871/:6908/:6944, referenced not driven).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { settleDelegationTerminal } from '../../../src/background/delegation-lifecycle.js';
import {
	compactBackgroundDelegations,
	publishPrReviewResultReceipt,
	readDelegationsDetailed,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { prReviewLaneResultEnvelopeDigest } from '../../../src/background/pr-review-contract.js';
import {
	readStageBDispatchBindings,
	recordStageBDispatchBindings,
} from '../../../src/background/stage-b-dispatch-binding-store.js';
import { reducePrReviewEvent } from '../../../src/pr-review/reducer.js';
import type {
	PrReviewEvent,
	PrReviewWorkflowState,
} from '../../../src/pr-review/types.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const POLICY = {
	enabled: true,
	canaryProbeMs: 300_000,
	statusProbeTimeoutMs: 2_000,
	correlatedFailureThreshold: 2,
	maxRetryAttemptsAfterInitial: 2,
	circuitOpenDurationMs: 60_000,
};

function baseState(revision: number): PrReviewWorkflowState {
	return {
		sessionID: 'ses_2908_wedge',
		workflowInstanceId: 'wfi_2908_wedge',
		revision,
		prHeadSha: 'head-sha',
		prReviewResilience: { policy: POLICY, attempts: [] },
	};
}

function terminal(status: 'completed' | 'error', nonce: string) {
	const text = `payload-${nonce}`;
	return {
		status,
		result: {
			text,
			chars: text.length,
			truncated: false,
			digest: `digest-${nonce}`,
		},
	} as const;
}

describe('settlement wedge-shape reproductions (issue #2908)', () => {
	const dirs: string[] = [];
	const newDir = (): string => {
		const dir = canonicalMkdtemp('settle-wedge-2908-');
		fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		dirs.push(dir);
		return dir;
	};
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Windows EBUSY on cleanup is environmental.
			}
		}
	});

	test('#2214 shape: a claimed lane terminal can never be re-opened or overwritten', async () => {
		const dir = newDir();
		const id = 'wedge-2214-lane';
		const pending = await recordPendingDelegation(dir, {
			correlationId: id,
			jobId: null,
			subagentSessionId: id,
			parentSessionId: 'wedge-parent',
			callID: `call-${id}`,
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'swarm_reviewer',
			planTaskId: null,
			evidenceTaskId: null,
		});
		expect(pending).not.toBeNull();
		const claimed = await settleDelegationTerminal(
			dir,
			pending!,
			terminal('completed', id),
			{},
			1_000,
		);
		expect(claimed.kind).toBe('claimed');
		const replay = await settleDelegationTerminal(
			dir,
			claimed.kind === 'claimed' ? claimed.record : pending!,
			terminal('completed', id),
			{},
			1_001,
		);
		expect(replay.kind).toBe('duplicate');
		const conflicting = await settleDelegationTerminal(
			dir,
			claimed.kind === 'claimed' ? claimed.record : pending!,
			terminal('error', `${id}-conflict`),
			{},
			1_002,
		);
		expect(['conflict', 'already_terminal_without_event']).toContain(
			conflicting.kind,
		);
		const folded = readDelegationsDetailed(dir).records.find(
			(record) => record.correlationId === id,
		);
		expect(folded?.status).toBe('completed');
		expect(folded?.terminalResult?.status).toBe('completed');
	});

	test('#2402 #2666 shape: a late older-generation result never advances the task', async () => {
		// Reducer defense-in-depth fence.
		const state = baseState(7);
		const stale: PrReviewEvent = {
			type: 'lane_structured_result_submitted',
			batchId: 'wedge-batch',
			laneId: 'wedge-lane',
			generation: 6,
			semanticEnvelopeDigest: 'wedge-digest',
			outcome: 'FINDINGS',
		};
		const rejected = reducePrReviewEvent(state, stale);
		expect(rejected.status).toBe('rejected');
		if (rejected.status === 'rejected') {
			expect(rejected.rejection.code).toBe('stale_generation_result');
			expect(rejected.state).toBe(state);
		}
		// The load-bearing publisher lock fence: a receipt whose expected
		// workflow revision does not match the durable record's is refused.
		const dir = newDir();
		const child = 'wedge-2666-child';
		const envelope = {
			schemaVersion: 1 as const,
			outcome: 'CLEAN' as const,
			creditedLanes: ['security-trust'],
			findings: [],
			cleanAttestations: [
				{
					workflowLane: 'security-trust',
					coverageScope: 'wedge coverage scope description',
					evidence: 'wedge evidence string long enough for the contract',
				},
			],
			unresolved: [],
		};
		const pending = await recordPendingDelegation(dir, {
			correlationId: child,
			jobId: null,
			subagentSessionId: child,
			parentSessionId: 'wedge-parent',
			callID: `call-${child}`,
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'swarm_reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'wedge-batch',
			laneId: 'wedge-lane',
			mode: 'swarm-pr-review:base',
			workflowLane: 'security-trust',
			workflowGeneration: 4,
		});
		expect(pending).not.toBeNull();
		const outcome = await publishPrReviewResultReceipt(dir, {
			parentSessionId: 'wedge-parent',
			childSessionId: child,
			batchId: 'wedge-batch',
			laneId: 'wedge-lane',
			expectedWorkflowInstanceId: 'wfi_2908_wedge',
			expectedWorkflowRevision: 3,
			expectedBaseSha: 'base-sha',
			receipt: {
				schemaVersion: 1,
				mode: 'swarm-pr-review:base',
				workflowInstanceId: 'wfi_2908_wedge',
				workflowRevision: 4,
				batchId: 'wedge-batch',
				laneId: 'wedge-lane',
				workflowLane: 'security-trust',
				ownedWorkflowLanes: ['security-trust'],
				baseSha: 'base-sha',
				headSha: 'head-sha',
				dispatchRevisionDigest: 'wedge-revision-digest',
				childSessionId: child,
				generation: 1,
				semanticEnvelopeDigest: prReviewLaneResultEnvelopeDigest(envelope),
				envelope,
			},
		});
		expect(outcome.status, 'stale-revision receipt must be refused').toBe(
			'conflict',
		);
		const after = readDelegationsDetailed(dir).records.find(
			(record) => record.correlationId === child,
		);
		expect(after?.status).toBe('pending');
		expect(after?.result?.prReviewResultReceipt).toBeUndefined();
	});

	test('#2840 shape: APPROVE with a disclosed degradation is rejected, REQUEST_CHANGES admitted', () => {
		const state = baseState(2);
		const event = (verdict: 'APPROVE' | 'REQUEST_CHANGES'): PrReviewEvent => ({
			type: 'coverage_finalization_requested',
			settlement: {
				kind: 'COMPLETE',
				coveredDimensions: [],
				unresolvedDimensions: [],
				liveDimensions: [],
			},
			requestedVerdict: verdict,
			disclosedDegradation: true,
		});
		const blocked = reducePrReviewEvent(state, event('APPROVE'));
		expect(blocked.status).toBe('rejected');
		if (blocked.status === 'rejected') {
			expect(blocked.rejection.code).toBe('degraded_disclosure_cannot_approve');
			expect(blocked.state).toBe(state);
		}
		expect(reducePrReviewEvent(state, event('REQUEST_CHANGES')).status).toBe(
			'applied',
		);
	});

	test('#2829 shape: a terminal survives a restart-fold and the binding store reconstructs across restart', async () => {
		const dir = newDir();
		const id = 'wedge-2829-lane';
		const pending = await recordPendingDelegation(dir, {
			correlationId: id,
			jobId: null,
			subagentSessionId: id,
			parentSessionId: 'wedge-parent',
			callID: `call-${id}`,
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'swarm_reviewer',
			planTaskId: null,
			evidenceTaskId: null,
		});
		expect(pending).not.toBeNull();
		const claimed = await settleDelegationTerminal(
			dir,
			pending!,
			terminal('completed', id),
			{},
			2_000,
		);
		expect(claimed.kind).toBe('claimed');
		const compact = await compactBackgroundDelegations(dir, { force: true });
		expect(compact.status).toBe('compacted');
		const refolded = readDelegationsDetailed(dir).records.find(
			(record) => record.correlationId === id,
		);
		expect(refolded?.status).toBe('completed');
		expect(refolded?.terminalResult?.status).toBe('completed');
		expect(refolded?.terminalResult?.eventId).toBe(
			claimed.kind === 'claimed'
				? claimed.record.terminalResult.eventId
				: undefined,
		);
		// Binding-store restart reconstruction: a durable binding written before
		// the restart reads back with its exact taskId + generation; an absent
		// binding reads fail-closed (the consumer drops the settlement —
		// warnStageBSettlementDropped, delegation-gate.ts drop sites).
		const session = 'wedge-2829-session';
		const call = 'wedge-2829-call';
		const recordedBinding = recordStageBDispatchBindings(dir, {
			sessionID: session,
			callID: call,
			bindings: [{ taskId: 'T-1', generation: 9 }],
		});
		expect(recordedBinding).toBe(true);
		const reconstructed = readStageBDispatchBindings(dir, session, call);
		expect(reconstructed?.bindings).toEqual([{ taskId: 'T-1', generation: 9 }]);
		expect(readStageBDispatchBindings(dir, session, 'absent-call')).toBeNull();
	});
});
