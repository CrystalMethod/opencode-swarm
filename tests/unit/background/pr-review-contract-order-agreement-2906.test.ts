// Issue #2906 (review F-08 LOW arm) — enum validation of the per-finding
// `order_agreement` label on the findings schema
// (`PrReviewFindingSchema` in src/background/pr-review-contract.ts). The
// label is model-supplied, so the schema is the first fail-closed boundary:
// anything outside {'agree','disagree','single'} must be rejected there.
import { describe, expect, test } from 'bun:test';
import {
	PrReviewFindingSchema,
	type PrReviewFindingStatus,
} from '../../../src/background/pr-review-contract.js';

const baseFinding = {
	finding_id: 'C-0',
	status: 'PENDING' as PrReviewFindingStatus,
	file_line: 'src/index.ts:1',
	evidence: 'enum-fixture evidence',
	next_action: 'report' as const,
};

describe('order_agreement enum validation (issue #2906)', () => {
	test("an invalid label like 'unstable' is rejected at the finding schema", () => {
		const parsed = PrReviewFindingSchema.safeParse({
			...baseFinding,
			order_agreement: 'unstable',
		});
		expect(parsed.success).toBe(false);
		if (parsed.success) return;
		const issue = parsed.error.issues.find((entry) =>
			entry.path.includes('order_agreement'),
		);
		expect(issue).toBeDefined();
		// The rejection must name the legal enum members, not a generic cause.
		expect(issue?.message).toContain('"agree"');
		expect(issue?.message).toContain('"disagree"');
		expect(issue?.message).toContain('"single"');
	});

	test.each([
		'agree',
		'disagree',
		'single',
	] as const)('legal label %s parses and round-trips', (label) => {
		const parsed = PrReviewFindingSchema.safeParse({
			...baseFinding,
			order_agreement: label,
		});
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.order_agreement).toBe(label);
	});

	test('an absent label stays legal (legacy pre-#2906 shape)', () => {
		const parsed = PrReviewFindingSchema.safeParse(baseFinding);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.order_agreement).toBeUndefined();
	});
});
