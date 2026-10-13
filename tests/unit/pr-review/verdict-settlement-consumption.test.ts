import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { join } from 'node:path';
import {
	assertPrReviewValidationSettled,
	_test_exports as gateInternals,
	readPrReviewVerdictSettlementEffectiveIds,
	recordPrReviewValidationBatch,
	resolvePrReviewWriterRunId,
} from '../../../src/hooks/pr-workflow-gate.js';
import { verdictSettlementDegradationActive } from '../../../src/pr-review/verdict-settlement.js';
import {
	HEAD_SHA,
	persistBatch,
	REVISION_DIGEST,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';
import {
	establishDeadReviewerWorld,
	establishFullInventory,
	reviewedRows,
	seedLivenessDeadLane,
} from './n-of-m-verdict-settlement.fixtures.js';

// Review PRR-006/008/035: consumption-time identity verification of the
// verdict-settlement receipt — the rejection direction every gate consumer
// relies on (wrong prHeadSha, wrong worktree revision, tampered content
// vs. the durable sha256 anchor). Previously none of this had executing
// coverage while the release fragment claimed identity was "verified at
// every read"; now that claim is true and tested.

const LIVE_LANE = 'n-of-m-live';
const DEAD_LANE = 'n-of-m-dead';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

async function settledRunId(): Promise<string> {
	await establishDeadReviewerWorld();
	await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
	return resolvePrReviewWriterRunId(tempDir, SESSION_ID);
}

describe('verdict settlement consumption identity (issue #3101, review PRR-006/008)', () => {
	test('an admitted receipt resolves its effective set (positive control)', async () => {
		const { deadItems } = await establishDeadReviewerWorld();
		await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
		const effective = await readPrReviewVerdictSettlementEffectiveIds(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		expect([...effective].sort()).toEqual([...deadItems].sort());
	});

	test('a content-tampered receipt fails closed against the durable sha256 anchor (review PRR-006)', async () => {
		const runId = await settledRunId();
		const receiptPath = join(
			tempDir,
			'.swarm',
			'pr-review',
			runId,
			'verdict-settlement.reviewer.json',
		);
		const raw = JSON.parse(await fs.readFile(receiptPath, 'utf-8')) as {
			items: Array<{ itemId: string }>;
		};
		// Tamper: rewrite the receipt with one FEWER item. The file stays
		// schema-valid and head/revision-identical, but it was rewritten after
		// the fact — the state-held anchor must reject it.
		raw.items = raw.items.slice(1);
		await fs.writeFile(receiptPath, JSON.stringify(raw, null, 2), 'utf-8');
		const effective = await readPrReviewVerdictSettlementEffectiveIds(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		expect(effective.size).toBe(0);
	});

	test('a receipt persisted with a foreign prHeadSha exercises no exemptions (module-level identity leg)', async () => {
		const runId = await settledRunId();
		const composed = (await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		)) as unknown as { unclaimed: string[] };
		const read = JSON.parse(
			await fs.readFile(
				join(
					tempDir,
					'.swarm',
					'pr-review',
					runId,
					'verdict-settlement.reviewer.json',
				),
				'utf-8',
			),
		) as { prHeadSha: string; items: unknown[] };
		expect(read.items.length).toBeGreaterThan(0);
		expect(read.prHeadSha).toBe(HEAD_SHA);
		// Module-level: the identity leg fails closed on a wrong head. (The
		// gate-level legs sit behind the anchor; this exercises the predicate
		// every consumer shares.)
		const degradedWrongHead = verdictSettlementDegradationActive({
			directory: tempDir,
			runId,
			prHeadSha: 'other-head',
			revisionDigest: REVISION_DIGEST,
			reviewerUnclaimed: composed.unclaimed,
			criticUnclaimed: [],
		});
		expect(degradedWrongHead).toBe(false);
	});

	test('a receipt whose worktree revision differs exercises no exemptions (module-level identity leg)', async () => {
		const runId = await settledRunId();
		const composed = (await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		)) as unknown as { unclaimed: string[] };
		const degradedWrongRevision = verdictSettlementDegradationActive({
			directory: tempDir,
			runId,
			prHeadSha: HEAD_SHA,
			revisionDigest: 'a-different-worktree-revision',
			reviewerUnclaimed: composed.unclaimed,
			criticUnclaimed: [],
		});
		expect(degradedWrongRevision).toBe(false);
	});
});

// Shared seeded-dead-lane helper re-export guard: keeps the fixture import
// surface honest for tree-shaking tools.
export { reviewedRows, seedLivenessDeadLane, DEAD_LANE };
