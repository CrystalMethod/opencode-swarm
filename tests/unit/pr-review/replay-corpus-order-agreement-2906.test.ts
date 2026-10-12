import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports as gateInternals,
	readPrWorkflowGateState,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

/**
 * Issue #2906 replay corpus — the deliberately order-flipping verdict shape
 * (review finding F-09: the #2906 required scope lists a replay-corpus case
 * whose verdict flips with presentation order; this is that case).
 *
 * The historical failure shape the corpus replays: pre-#2906 reviewer passes
 * ran in a single fixed candidate order, so a verdict that depended on
 * presentation order was indistinguishable from a stable one — nothing
 * recorded which order observed which verdict, so no label could say
 * 'disagree'. The counterbalanced A/B passes now stamp `presentationOrder` on
 * every reviewer batch, and the composition path in
 * `src/pr-review/legacy-transcript-adapter.ts` records per-(item, order)
 * observations — including through the agreement-only continuation, which is
 * the only route to the older pass when the newest pass claims the whole
 * inventory and the main loop early-exits.
 *
 * Replay shape: two full-inventory counterbalanced passes over the same
 * candidate inventory. Pass A (canonical order) sees every item
 * CONFIRMED/HIGH. Pass B (reversed order) sees the same inventory except:
 *  - C-3 flips severity only (CONFIRMED/HIGH -> CONFIRMED/MEDIUM)
 *  - C-4 flips classification only at equal severity
 *    (CONFIRMED/HIGH -> UNVERIFIED/HIGH)
 * Every other item is order-stable. The composed per-finding `order_agreement`
 * labels must therefore pin BOTH outcomes at once: 'disagree' on each flipped
 * finding (each through a different comparison field, so removing either the
 * classification or the severity comparison goes red) and 'agree' on every
 * stable finding — the flip is visible in the label, not only in the claim.
 */

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

const reviewedRow = (
	id: string,
	classification: string,
	severity: string,
): string =>
	`[REVIEWED] | ${id} | ${classification} | STRUCTURALLY_PROVEN | ${severity} | YES | file.ts:1 | rationale ${id} | probe ${id} | reviewer | ORDINARY | `;

/** The full candidate inventory of `establishReviewPrerequisites` (C-0..C-5). */
const INVENTORY = ['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5'];
/** Items whose verdict is identical in both presentation orders. */
const STABLE = ['C-0', 'C-1', 'C-2', 'C-5'];

type PassVerdict = Record<string, { classification: string; severity: string }>;

async function counterbalancedPass(
	batchId: string,
	verdicts: PassVerdict,
): Promise<void> {
	// Declaration stamps this batch's counterbalanced presentation order
	// (first reviewer batch -> 'A', second -> 'B') and fixes the validated
	// inventory the composition path gates every observation against.
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: `${batchId}-lane`,
				workflowLane: `${batchId}-lane`,
				reviewItemIds: [...INVENTORY],
			},
		],
		{ batchId, prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		batchId,
		'swarm-pr-review:reviewer',
		[{ laneId: `${batchId}-lane`, workflowLane: `${batchId}-lane` }],
		{
			textOverride: INVENTORY.map((id) => {
				const verdict = verdicts[id] ?? {
					classification: 'CONFIRMED',
					severity: 'HIGH',
				};
				return reviewedRow(id, verdict.classification, verdict.severity);
			}).join('\n'),
			subagentSessionId: `${batchId}-lane`,
		},
	);
}

describe('replay corpus: deliberately order-flipping verdict over counterbalanced passes (#2906, review F-09)', () => {
	test('flipped findings compose order_agreement disagree while stable findings compose agree', async () => {
		await establishReviewPrerequisites();
		// Pass A (canonical order): every item CONFIRMED/HIGH.
		await counterbalancedPass('flip-a', {});
		// Pass B (reversed order): C-3 flips severity, C-4 flips
		// classification, everything else is order-stable.
		await counterbalancedPass('flip-b', {
			'C-3': { classification: 'CONFIRMED', severity: 'MEDIUM' },
			'C-4': { classification: 'UNVERIFIED', severity: 'HIGH' },
		});

		// The premise of the case: the two passes are genuinely
		// counterbalanced (A then B), stamped by the record path itself.
		const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(state?.prReviewBatchCoherence?.['flip-a']?.presentationOrder).toBe(
			'A',
		);
		expect(state?.prReviewBatchCoherence?.['flip-b']?.presentationOrder).toBe(
			'B',
		);

		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		expect(composed.unclaimed).toEqual([]);
		// Pass B is newest and claims the whole inventory, so the main loop
		// early-exits: pass A contributed no claims, and its observations
		// reach the composition ONLY through the #2906 agreement-only
		// continuation — the code under test.
		expect(composed.contributingBatchIds).toEqual(['flip-b']);

		// Order-stable findings: identical (classification, severity) in
		// both orders -> 'agree'.
		for (const id of STABLE) {
			const claim = composed.claims.get(id);
			expect(claim?.classification).toBe('CONFIRMED');
			expect(claim?.severity).toBe('HIGH');
			expect(claim?.batchId).toBe('flip-b');
			expect(claim?.orderAgreement).toBe('agree');
		}

		// Severity-only flip: the newest pass wins the claim
		// (CONFIRMED/MEDIUM) while the label exposes the order instability.
		const severityFlip = composed.claims.get('C-3');
		expect(severityFlip?.classification).toBe('CONFIRMED');
		expect(severityFlip?.severity).toBe('MEDIUM');
		expect(severityFlip?.batchId).toBe('flip-b');
		expect(severityFlip?.orderAgreement).toBe('disagree');

		// Classification-only flip at equal severity: only the
		// classification comparison can see this disagreement.
		const classificationFlip = composed.claims.get('C-4');
		expect(classificationFlip?.classification).toBe('UNVERIFIED');
		expect(classificationFlip?.severity).toBe('HIGH');
		expect(classificationFlip?.batchId).toBe('flip-b');
		expect(classificationFlip?.orderAgreement).toBe('disagree');
	});
});
