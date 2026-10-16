// Issue #3310 AC17 — council explorer lanes get a COUNCIL-SPECIFIC contract.
//
// At base, applyExplorerFormatSuffix appends the MICRO discovery suffix to
// swarm-pr-review:council explorer lanes, which instructs them to settle via
// the `submit_pr_review_result` tool (Profile A discovery settlement
// guidance). Council lanes are challenge lanes, not discovery settlers, and
// their agent default is fenced-JSON replies — the micro contract is wrong
// for them twice over.
//
// RED at base, GREEN after the fix: council explorer lane prompts must NOT
// contain the submit_pr_review_result settlement guidance and MUST contain a
// response-format override stating the reply format is plain marker rows
// (overriding the council agent's fenced-JSON default). The micro row-family
// identity (the micro [CANDIDATE] header) stays so the lane still knows its
// row family.
import { afterEach, describe, expect, test } from 'bun:test';
import { CANDIDATE_HEADERS } from '../../../src/background/candidate-contract.js';
import {
	_internals,
	_test_exports,
} from '../../../src/tools/dispatch-lanes.js';

const originalInternals = { ..._internals };

afterEach(() => {
	Object.assign(_internals, originalInternals);
});

describe('council explorer lane contract (issue #3310 AC17)', () => {
	test('council explorer lanes drop discovery settlement guidance and gain a plain-rows response override', () => {
		_internals.getGeneratedAgentNames = () => ['council_generalist'];
		const result = _test_exports.applyExplorerFormatSuffix(
			[
				{
					id: 'council',
					agent: 'council_generalist',
					prompt: 'challenge the candidates',
					workflow_lane: 'council-generalist',
				},
			],
			{ failClosed: true, mode: 'swarm-pr-review:council' },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.errors.join('; '));
		const prompt = result.lanes[0]?.prompt ?? '';
		if (prompt === '') throw new Error('format pass returned no prompt');
		// The council lane must NOT be told to settle via the discovery tool.
		expect(prompt).not.toContain('submit_pr_review_result');
		// It MUST carry a response-format override phrased as a response/reply
		// statement naming plain rows. The anchor requires the
		// response/reply lead-in so the micro suffix's incidental
		// "as plain text ... fenced rows" line cannot satisfy it.
		expect(prompt).toMatch(
			/(?:response|reply)[^\n]{0,120}plain[^\n]{0,60}rows/i,
		);
		// The row-family identity survives: the lane still knows its rows are
		// the micro [CANDIDATE] family.
		expect(prompt).toContain(CANDIDATE_HEADERS.micro_lane);
		expect(prompt).toContain('[CANDIDATE]');
	});
});
