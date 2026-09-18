import { describe, expect, test } from 'bun:test';
import { _test_exports } from '../../../src/tools/dispatch-lanes.js';

// Issue #2835 acceptance check C6 (DISCRIMINATING — RED at base).
//
// AC5 second half: the dispatched lane prompt's structured-submission
// instruction must carry the revision_digest value the lane must echo into
// submit_pr_review_result (whose schema requires top-level revisionDigest
// ^[0-9a-f]{64}$ — src/tools/submit-pr-review-result.ts:11-14).
//
// Root cause D3: the contract block renders revision_digest on its own line
// (dispatch-lanes.ts:5696) but the "Structured settlement rule" instruction
// (:5680-5684) tells the lane to call submit_pr_review_result with
// batchId/laneId only — so the lane is never told WHICH digest to echo, and
// any echoed guess fails the 64-hex schema.
//
// Probe: render the contract through the same builder the dispatch path uses
// (_test_exports.applyPrWorkflowPromptContract — the contractPromptLanes seam
// at dispatch-lanes.ts:1469-1483) and require the digest hex to appear WITHIN
// the structured-submission instruction paragraph itself (not merely anywhere
// in the prompt, where the contract header already carries it at base).

const REVISION_DIGEST =
	'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const PR_HEAD_SHA = 'abc123def456abc123def456abc123def456abc1';

describe('C6: the structured-submission instruction must carry the revision digest the lane echoes into submit_pr_review_result', () => {
	test('the "Structured settlement rule" paragraph contains the revision digest hex', () => {
		const contracted = _test_exports.applyPrWorkflowPromptContract(
			[
				{
					id: 'micro-lane-unclassified',
					agent: 'explorer',
					prompt: 'Inspect the exact reviewed diff for unclassified risk.',
					workflow_lane: 'unclassified-risk',
				},
			],
			{
				mode: 'swarm-pr-review:micro',
				batchId: 'micro-batch-dead',
				prHeadSha: PR_HEAD_SHA,
				revisionDigest: REVISION_DIGEST,
				scope: `complete PR diff def456...${PR_HEAD_SHA}`,
				callerFocus: undefined,
			},
		);
		expect(contracted.ok).toBe(true);
		if (!contracted.ok) return;
		const prompt = String(contracted.lanes[0]?.prompt ?? '');

		// Sanity anchors: the rendered contract does include the digest token
		// somewhere (the header line) and the submit instruction exists.
		expect(prompt).toContain(`revision_digest: ${REVISION_DIGEST}`);
		const instructionStart = prompt.indexOf('Structured settlement rule');
		expect(
			instructionStart,
			'the structured-submission instruction paragraph must exist in the rendered contract',
		).toBeGreaterThanOrEqual(0);
		const instructionEnd = prompt.indexOf('Read-only shell rules');
		const instruction = prompt.slice(
			instructionStart,
			instructionEnd > instructionStart ? instructionEnd : undefined,
		);
		// The decisive assertion: the digest the lane must echo into
		// submit_pr_review_result's revisionDigest field is part of the submit
		// instruction itself. At base the instruction names batchId/laneId only
		// and the digest lives solely in the contract header above it.
		expect(
			instruction,
			`the structured-submission instruction must tell the lane WHICH revision digest to echo into submit_pr_review_result (${REVISION_DIGEST}); instruction was: ${JSON.stringify(instruction)}`,
		).toContain(REVISION_DIGEST);
	});
});
