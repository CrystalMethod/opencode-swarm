// Issue #3310 AC6 — reviewer-lane protocol selection clause.
//
// The reviewer agent's base prompt carries the Stage-B
// '## STRUCTURED VERDICT LINE (MANDATORY)' mandate: task-keyed
// `[REVIEWED] | task-<id> | <verdict> | ...` rows. A swarm-pr-review
// reviewer lane instead settles under the PR-review [REVIEWED] row grammar
// keyed by ASSIGNED ITEM ids (rendered by the controller contract card), so
// the task-keyed Stage-B mandate must be explicitly disclaimed inside the
// controller-owned PR workflow contract — otherwise a reviewer lane may emit
// task-keyed verdict rows the PR-review collector cannot parse.
//
// RED at base, GREEN after the fix: applyPrWorkflowPromptContract in
// src/tools/dispatch-lanes.ts gains a reviewer-mode-only clause that
// (a) names 'STRUCTURED VERDICT LINE', (b) states it does not apply to this
// lane, and (c) instructs that no task-keyed [REVIEWED] row is to be emitted.
// Critic-mode and base/micro discovery-mode prompts must NOT carry the
// reviewer-specific clause (mode scoping).
import { describe, expect, test } from 'bun:test';
import { _test_exports } from '../../../src/tools/dispatch-lanes.js';

type ContractOptions = Parameters<
	typeof _test_exports.applyPrWorkflowPromptContract
>[1];
type ContractLane = Parameters<
	typeof _test_exports.applyPrWorkflowPromptContract
>[0][number];

const reviewerLane: ContractLane = {
	id: 'rev-3310-1',
	agent: 'reviewer',
	prompt: 'Caller-authored reviewer prompt',
	workflow_lane: 'rev-chunk-1',
	review_item_ids: ['c1', 'c2'],
};

function contract(lane: ContractLane, options: ContractOptions): string {
	const result = _test_exports.applyPrWorkflowPromptContract([lane], options);
	if (!result.ok) {
		throw new Error(`contract rejected: ${result.errors.join('; ')}`);
	}
	const prompt = result.lanes[0]?.prompt ?? '';
	if (prompt === '') throw new Error('contract returned no prompt');
	return prompt;
}

describe('reviewer-lane protocol selection clause (issue #3310 AC6)', () => {
	test('reviewer-mode prompt disclaims the Stage-B STRUCTURED VERDICT LINE mandate', () => {
		const prompt = contract(reviewerLane, {
			mode: 'swarm-pr-review:reviewer',
			prHeadSha: 'abc123',
			revisionDigest: 'revision-1',
		});
		// (a) The clause names the Stage-B mandate.
		expect(prompt).toContain('STRUCTURED VERDICT LINE');
		// (b) It states the mandate does not apply to this lane.
		expect(prompt).toMatch(/does not apply/i);
		// (c) It instructs that no task-keyed [REVIEWED] row is to be emitted:
		// the [REVIEWED] marker and a `task-` key appear together on one line,
		// in either order (covers "no `[REVIEWED] | task-<id>` row" phrasings
		// and "no task-keyed [REVIEWED] row" phrasings alike).
		expect(prompt).toMatch(
			/\[REVIEWED\][^\n]{0,120}task-|task-[^\n]{0,120}\[REVIEWED\]/,
		);
	});

	test('critic-mode prompt does not carry the reviewer-specific clause', () => {
		const prompt = contract(
			{
				id: 'critic-3310-1',
				agent: 'critic',
				prompt: 'Caller-authored critic prompt',
				workflow_lane: 'critic-chunk-1',
				review_item_ids: ['c1', 'c2'],
			},
			{
				mode: 'swarm-pr-review:critic',
				prHeadSha: 'abc123',
				revisionDigest: 'revision-1',
			},
		);
		expect(prompt).not.toContain('STRUCTURED VERDICT LINE');
	});

	test.each([
		'swarm-pr-review:base',
		'swarm-pr-review:micro',
	] as const)('%s discovery prompts do not carry the reviewer-specific clause', (mode) => {
		const prompt = contract(
			{
				id: 'discovery-3310-1',
				agent: 'explorer',
				prompt: 'Caller-authored discovery prompt',
				workflow_lane: 'intent-architecture',
			},
			{
				mode,
				prHeadSha: 'abc123',
				revisionDigest: 'revision-1',
			},
		);
		expect(prompt).not.toContain('STRUCTURED VERDICT LINE');
	});
});
