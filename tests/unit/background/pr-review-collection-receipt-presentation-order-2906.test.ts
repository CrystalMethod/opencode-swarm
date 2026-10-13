// Issue #2906 — collection-receipt presentationOrder additivity: the footer
// payload gains an optional enum field; old payloads (no field) still parse,
// the field round-trips when supplied, and absent bindings keep the footer
// byte-identical (field key omitted entirely — the C6 compatibility pin).
import { describe, expect, test } from 'bun:test';
import {
	encodePrReviewCollectionReceiptFooter,
	type PrReviewCollectionReceiptBinding,
	parsePrReviewCollectionReceiptFooter,
} from '../../../src/background/pr-review-collection-receipt.js';

const binding = (
	presentationOrder?: 'A' | 'B',
): PrReviewCollectionReceiptBinding => ({
	parentSessionId: 'receipt-2906-session',
	batchId: 'batch-2906',
	callID: 'call-2906',
	laneId: 'lane-2906',
	correlationId: 'corr-2906',
	mode: 'swarm-pr-review:reviewer',
	workflowLane: 'wf-2906',
	...(presentationOrder ? { presentationOrder } : {}),
});

const receipt = {
	assignedReviewItemIds: ['C-1'],
	acceptedReviewItemIds: ['C-1'],
	rejectedReviewItemIds: [],
};

const resultFor = (text?: string) => ({
	text,
	digest: 'a'.repeat(64),
});

describe('collection receipt presentationOrder (issue #2906)', () => {
	test('absent binding value omits the field key entirely (C6 compat)', () => {
		const footer = encodePrReviewCollectionReceiptFooter(
			binding(),
			resultFor(),
			receipt,
		);
		expect(typeof footer).toBe('string');
		expect(footer ?? '').not.toContain('presentationOrder');
	});

	test("supplied 'A' lands in the payload and round-trips through the parser", () => {
		const footer = encodePrReviewCollectionReceiptFooter(
			binding('A'),
			resultFor(),
			receipt,
		);
		expect(footer ?? '').toContain('"presentationOrder":"A"');
		const parsed = parsePrReviewCollectionReceiptFooter(
			binding('A'),
			resultFor(footer ?? undefined),
		);
		expect(parsed?.presentationOrder).toBe('A');
	});

	test("supplied 'B' round-trips; the value is enum-narrow at parse time", () => {
		const footer = encodePrReviewCollectionReceiptFooter(
			binding('B'),
			resultFor(),
			receipt,
		);
		const parsed = parsePrReviewCollectionReceiptFooter(
			binding('B'),
			resultFor(footer ?? undefined),
		);
		expect(parsed?.presentationOrder).toBe('B');
	});

	test('an old-shape payload (no field) still parses with the field absent', () => {
		const legacyFooter = encodePrReviewCollectionReceiptFooter(
			binding(),
			resultFor(),
			receipt,
		);
		const parsed = parsePrReviewCollectionReceiptFooter(
			binding(),
			resultFor(legacyFooter ?? undefined),
		);
		expect(parsed).not.toBeNull();
		expect(parsed?.presentationOrder).toBeUndefined();
	});
});
