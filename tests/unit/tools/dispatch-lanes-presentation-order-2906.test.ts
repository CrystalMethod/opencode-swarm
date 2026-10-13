// Issue #2906 — counterbalanced presentation order on the reviewer prompt
// contract, order-unstable routing on the critic contract, and the
// absent-options byte-compat guarantee (AC1/AC4/AC6 surfaces at repo-suite
// level; the frozen checks pin the same seams pre-merge).
import { describe, expect, test } from 'bun:test';
import { _test_exports } from '../../../src/tools/dispatch-lanes.js';

type ContractOptions = Parameters<
	typeof _test_exports.applyPrWorkflowPromptContract
>[1];

const reviewerLane = {
	id: 'rev-2906-1',
	agent: 'reviewer',
	prompt: 'Caller-authored prompt',
	workflow_lane: 'rev-chunk-1',
	review_item_ids: ['C-3', 'C-1', 'C-2'],
};

const criticLane = {
	id: 'critic-2906-1',
	agent: 'critic',
	prompt: 'Caller-authored prompt',
	workflow_lane: 'critic-chunk-1',
	review_item_ids: ['C-1', 'C-2'],
};

function contract(
	lane: typeof reviewerLane | typeof criticLane,
	options: ContractOptions,
): string {
	const contracted = _test_exports.applyPrWorkflowPromptContract([lane], {
		prHeadSha: 'abc123',
		revisionDigest: 'revision-1',
		...options,
	});
	if (!contracted.ok) {
		throw new Error(`contract rejected: ${contracted.errors.join('; ')}`);
	}
	const prompt = contracted.lanes[0]?.prompt ?? '';
	if (prompt === '') throw new Error('contract returned no prompt');
	return prompt;
}

const reviewerOptions = (extra: Record<string, unknown> = {}) =>
	({
		mode: 'swarm-pr-review:reviewer',
		...extra,
	}) as ContractOptions;

const criticOptions = (extra: Record<string, unknown> = {}) =>
	({
		mode: 'swarm-pr-review:critic',
		...extra,
	}) as ContractOptions;

describe('reviewer presentation-order rendering (issue #2906)', () => {
	test('pass A renders canonical sorted ids and the presentation_order line', () => {
		const prompt = contract(
			reviewerLane,
			reviewerOptions({ presentationOrder: 'A' }),
		);
		expect(prompt).toContain('assigned_item_ids: C-1, C-2, C-3');
		expect(prompt).toContain('presentation_order: A');
		expect(prompt).toContain('canonical');
	});

	test('pass B renders the exact reverse', () => {
		const prompt = contract(
			reviewerLane,
			reviewerOptions({ presentationOrder: 'B' }),
		);
		expect(prompt).toContain('assigned_item_ids: C-3, C-2, C-1');
		expect(prompt).toContain('presentation_order: B');
		expect(prompt).toContain('reversed');
	});

	test('absent options keep the caller-declared order verbatim (byte-compat)', () => {
		const prompt = contract(reviewerLane, reviewerOptions());
		expect(prompt).toContain('assigned_item_ids: C-3, C-1, C-2');
		expect(prompt).not.toContain('presentation_order:');
		expect(prompt).not.toContain('order_unstable_item_ids:');
	});

	test('explicit undefined presentationOrder is exactly absent', () => {
		const prompt = contract(
			reviewerLane,
			reviewerOptions({ presentationOrder: undefined }),
		);
		expect(prompt).toContain('assigned_item_ids: C-3, C-1, C-2');
		expect(prompt).not.toContain('presentation_order:');
	});

	test('presentationOrder on a critic lane is ignored (wrong mode)', () => {
		const prompt = contract(
			criticLane,
			criticOptions({ presentationOrder: 'B' }),
		);
		expect(prompt).not.toContain('presentation_order:');
	});

	test('single-item inventory renders identical A and B id lists', () => {
		const single = { ...reviewerLane, review_item_ids: ['C-1'] };
		const promptA = contract(
			single,
			reviewerOptions({ presentationOrder: 'A' }),
		);
		const promptB = contract(
			single,
			reviewerOptions({ presentationOrder: 'B' }),
		);
		expect(promptA).toContain('assigned_item_ids: C-1');
		expect(promptB).toContain('assigned_item_ids: C-1');
	});
});

describe('critic order-unstable routing (issue #2906)', () => {
	test('renders order_unstable_item_ids for unstable assigned items only', () => {
		const prompt = contract(
			criticLane,
			criticOptions({ orderUnstableItemIds: ['C-2', 'C-9'] }),
		);
		expect(prompt).toContain('order_unstable_item_ids: C-2');
		expect(prompt).not.toContain('C-9');
	});

	test('renders the explicit (none) form for an empty unstable set', () => {
		const prompt = contract(
			criticLane,
			criticOptions({ orderUnstableItemIds: [] }),
		);
		expect(prompt).toContain('order_unstable_item_ids: (none)');
	});

	test('undefined orderUnstableItemIds renders no line at all', () => {
		const prompt = contract(
			criticLane,
			criticOptions({ orderUnstableItemIds: undefined }),
		);
		expect(prompt).not.toContain('order_unstable_item_ids:');
	});

	test('orderUnstableItemIds on a reviewer lane is ignored (wrong mode)', () => {
		const prompt = contract(
			reviewerLane,
			reviewerOptions({ orderUnstableItemIds: ['C-2'] }),
		);
		expect(prompt).not.toContain('order_unstable_item_ids:');
	});
});
