import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	prWorkflowSessionFileStem,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import { writeAuthoritativePrWorkflowState } from '../../helpers/pr-workflow-state-authority.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	persistBatch,
	REVISION_DIGEST,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

/**
 * Issue #3098 check C1 (DISCRIMINATING). `composePrReviewPhaseVerdicts`
 * (src/pr-review/legacy-transcript-adapter.ts) calls
 * `loadArtifactPassingLaneIntegrity` WITHOUT the optional `diagnostics`
 * parameter, so when a declared reviewer lane's artifact fails integrity the
 * typed failure `{predicate, expected, actual}` (formatted by
 * `formatPrReviewLaneValidationFailure`) is discarded and the composition emits
 * the predicate-free string
 * `declared reviewer lane "..." produced no successful exact artifact`.
 *
 * The fix must make that diagnostic entry carry the typed predicate AND, when
 * one exists, the lane's last journaled `write_pr_review_artifact` rejection
 * (the verdict-lane mirror of the discovery submit-rejection journal, issue
 * #2859 F3).
 *
 * Fixture note (deviation from the trace plan, documented deliberately):
 * `persistBatch`'s single `head` option stamps the delegation record's
 * workspace AND the stored artifact together. A shared wrong head trips the
 * RECORD-level `record.pr_head_sha` predicate inside
 * `recordsPassingBatchIntegrity`, which filters the record out BEFORE the
 * composition ever reaches `loadArtifactPassingLaneIntegrity` — that variant
 * can never witness the discarded ARTIFACT-level typed failure this check
 * freezes. `persistBatchWithDivergentArtifactHead` below therefore keeps the
 * record's workspace head equal to the gate HEAD (the record passes the
 * identity chain) while the stored artifact carries a different head, tripping
 * `artifact.pr_head_sha` exactly at the loadArtifactPassingLaneIntegrity call
 * the bug lives in.
 */

const BASE_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);

const WRONG_ARTIFACT_HEAD = 'fff4562222222222222222222222222222222222';

const reviewed = (ids: readonly string[]): string =>
	ids
		.map(
			(id) =>
				`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer | ORDINARY | `,
		)
		.join('\n');

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

/**
 * Persist one reviewer lane whose delegation record passes the record-level
 * identity chain (workspace head = gate HEAD_SHA) while the stored artifact
 * carries WRONG_ARTIFACT_HEAD — the artifact-level integrity failure
 * (`artifact.pr_head_sha`) that loadArtifactPassingLaneIntegrity computes and,
 * at base, silently discards. Mirrors persistBatch's internals with the single
 * divergence under test.
 */
async function persistBatchWithDivergentArtifactHead(
	batchId: string,
	lane: { laneId: string; workflowLane: string },
	rows: string,
): Promise<string> {
	const subagentSessionId = `${batchId}--${lane.laneId}`;
	await recordPendingDelegation(tempDir, {
		correlationId: subagentSessionId,
		jobId: null,
		subagentSessionId,
		parentSessionId: SESSION_ID,
		callID: `call-${subagentSessionId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId: lane.laneId,
		mode: 'swarm-pr-review:reviewer',
		workflowLane: lane.workflowLane,
		workspace: {
			directory: tempDir,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
	const stored = storeLaneOutput(tempDir, {
		batchId,
		laneId: lane.laneId,
		agent: 'reviewer',
		role: 'reviewer',
		sessionId: subagentSessionId,
		parentSessionId: SESSION_ID,
		mode: 'swarm-pr-review:reviewer',
		workflowLane: lane.workflowLane,
		prHeadSha: WRONG_ARTIFACT_HEAD,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		source: 'collect_lane_results',
		text: rows,
	});
	await appendDelegationTransition(tempDir, subagentSessionId, {
		status: 'completed',
		result: {
			text: rows,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			...(stored.ref ? { outputRef: stored.ref } : {}),
		},
	});
	return subagentSessionId;
}

/** Declares + persists the two reviewer batches the checks need. */
async function establishCoveredAndIntegrityFailedLanes(): Promise<void> {
	await establishReviewPrerequisites();
	// Batch 1 settles everything: the covered lane's artifact is exact.
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: 'rv-covered-a',
				workflowLane: 'rv-covered-a',
				reviewItemIds: [...BASE_IDS],
			},
		],
		{ batchId: 'rv-covered', prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		'rv-covered',
		'swarm-pr-review:reviewer',
		[{ laneId: 'rv-covered-a', workflowLane: 'rv-covered-a' }],
		{ textOverride: reviewed(BASE_IDS) },
	);
	// Batch 2 (separate batch: one lane per batch — recordPrReviewValidationBatch
	// rejects duplicate item ownership within one batch) declares a lane whose
	// artifact fails artifact-level head integrity.
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: 'rv-failed-a',
				workflowLane: 'rv-failed-a',
				reviewItemIds: [...BASE_IDS],
			},
		],
		{ batchId: 'rv-failed', prHeadSha: HEAD_SHA },
	);
	await persistBatchWithDivergentArtifactHead(
		'rv-failed',
		{ laneId: 'rv-failed-a', workflowLane: 'rv-failed-a' },
		reviewed(BASE_IDS),
	);
}

function gateStatePath(): string {
	return path.join(
		tempDir,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
	);
}

describe('composePrReviewPhaseVerdicts failed-lane diagnostics (issue #3098)', () => {
	test('an integrity-failed declared lane diagnostic carries the typed predicate', async () => {
		await establishCoveredAndIntegrityFailedLanes();
		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		// Settlement truth stays intact: the covered lane settled every item, so
		// the failed lane remains a diagnostic, never a block.
		expect(composed.unclaimed).toEqual([]);
		const entry = composed.diagnostics.find((line) =>
			line.includes('declared reviewer lane "rv-failed-a"'),
		);
		expect(entry).toBeDefined();
		// The frozen contract: the abandoned-lane diagnostic must not be
		// predicate-free. It must carry the typed lane-validation failure the
		// integrity layer already computed, in its established rendering
		// (formatPrReviewLaneValidationFailure: `predicate=<axis> expected=... actual=...`).
		expect(entry).toContain('predicate=');
		expect(entry).toContain('artifact.pr_head_sha');
	});

	test('the failed-lane diagnostic carries the lane last journaled verdict write rejection', async () => {
		await establishCoveredAndIntegrityFailedLanes();
		// Seed the mirroring verdict-rejection journal on the gate state. The
		// field name and entry shape below are the FIX's contract to satisfy
		// (issue #3098: a bounded FIFO `prReviewVerdictRejections` journal written
		// by recordPrReviewVerdictRejection on the tool caller's session gate,
		// attributed to the failing lane). At base the field does not exist and
		// the state codec may strip it; the check stays executable and honest by
		// asserting on the COMPOSED DIAGNOSTIC, which is RED at base either way.
		const failedLaneSubagentSessionId = 'rv-failed--rv-failed-a';
		const state = JSON.parse(
			await fs.readFile(gateStatePath(), 'utf-8'),
		) as Record<string, unknown>;
		state.prReviewVerdictRejections = [
			{
				sessionId: failedLaneSubagentSessionId,
				laneId: 'rv-failed-a',
				workflowLane: 'rv-failed-a',
				at: 1,
				message:
					'last rejected write_pr_review_artifact: boundary mismatch probe',
			},
		];
		await writeAuthoritativePrWorkflowState(
			tempDir,
			state as {
				sessionID: string;
				revision: number;
				mode: string;
				[key: string]: unknown;
			},
		);
		gateInternals.resetTrackedStateCache();

		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		expect(composed.unclaimed).toEqual([]);
		const entry = composed.diagnostics.find((line) =>
			line.includes('declared reviewer lane "rv-failed-a"'),
		);
		expect(entry).toBeDefined();
		// Frozen spec (mirrors the discovery contract's
		// `; last rejected submit_pr_review_result: ...` surfacing, issue #2859):
		// when the lane has a journaled verdict write rejection, the failed-lane
		// diagnostic surfaces it.
		expect(entry).toContain('last rejected write_pr_review_artifact');
	});
});
