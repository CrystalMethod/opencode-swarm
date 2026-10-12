// Issue #2906 review finding F-02 (Stage B blocker: the fix branch shipped
// untested): a flip whose NEWEST pass is DISPROVED is not critic-routed and
// submission drops DISPROVED rows as not-findings, so the item was neither
// marked nor counted. The fix routes those rows through a separate renderer
// input. These arms pin that path so deleting the wire goes red.
import { describe, expect, test } from 'bun:test';
import {
	type RendererFinding,
	renderPrReviewSubmissionBody,
} from '../../../src/pr-review/render-review-body.js';

const finding = (
	id: string,
	overrides: Partial<RendererFinding> = {},
): RendererFinding => ({
	finding_id: id,
	status: 'CONFIRMED',
	file_line: 'src/T.ts:12',
	evidence: `evidence ${id}`,
	next_action: 'apply the required change',
	severity: 'HIGH',
	...overrides,
});

describe('order-unstable findings suppressed from the findings list (#2906)', () => {
	test('a DISPROVED order-unstable row renders in its own section and counts', () => {
		const result = renderPrReviewSubmissionBody({
			run_id: 'run-2906',
			pr_head_sha: 'abc123',
			coverage: { kind: 'FULL', unresolved_dimensions: [] },
			findings: [finding('T-201', { order_agreement: 'agree' })],
			order_unstable_suppressed: [
				finding('T-202', {
					status: 'DISPROVED',
					severity: 'NONE',
					order_agreement: 'disagree',
				}),
			],
		});
		expect(result.body).toContain(
			'## Order-unstable (not published as findings)',
		);
		expect(result.body).toContain('T-202');
		expect(result.body).toContain('disproved');
		expect(result.orderUnstableCount).toBe(1);
		expect(result.orderUnstableCount).toBeGreaterThan(0);
	});

	test('the suppressed row stays out of the findings list', () => {
		const result = renderPrReviewSubmissionBody({
			run_id: 'run-2906',
			pr_head_sha: 'abc123',
			coverage: { kind: 'FULL', unresolved_dimensions: [] },
			findings: [finding('T-201', { order_agreement: 'agree' })],
			order_unstable_suppressed: [
				finding('T-202', {
					status: 'DISPROVED',
					severity: 'NONE',
					order_agreement: 'disagree',
				}),
			],
		});
		const findingsSection = result.body.slice(
			result.body.indexOf('## Findings'),
			result.body.indexOf('## Order-unstable'),
		);
		expect(findingsSection).not.toContain('T-202');
		expect(findingsSection).toContain('T-201');
		// The suppressed row must not produce an inline comment either.
		expect(result.inlineComments.map((c) => c.finding_id)).not.toContain(
			'T-202',
		);
	});

	test('live and suppressed unstable rows both count, exactly once each', () => {
		const result = renderPrReviewSubmissionBody({
			run_id: 'run-2906',
			pr_head_sha: 'abc123',
			coverage: { kind: 'FULL', unresolved_dimensions: [] },
			findings: [finding('T-201', { order_agreement: 'disagree' })],
			order_unstable_suppressed: [
				finding('T-202', {
					status: 'DISPROVED',
					severity: 'NONE',
					order_agreement: 'disagree',
				}),
			],
		});
		expect(result.orderUnstableCount).toBe(2);
		// Exactly ONE summary sentence carries the total, whatever the mix.
		const summaries = result.body
			.split('\n')
			.filter((line) => line.includes('order-unstable across'));
		expect(summaries.length).toBe(1);
		expect(summaries[0]).toContain('2 finding(s)');
	});

	test('no suppressed rows means no extra section and no extra count', () => {
		const result = renderPrReviewSubmissionBody({
			run_id: 'run-2906',
			pr_head_sha: 'abc123',
			coverage: { kind: 'FULL', unresolved_dimensions: [] },
			findings: [finding('T-201', { order_agreement: 'agree' })],
			order_unstable_suppressed: [],
		});
		expect(result.body).not.toContain('Order-unstable (not published');
		expect(result.orderUnstableCount).toBe(0);
	});

	test('a suppressed row WITHOUT the disagree label is ignored entirely', () => {
		const result = renderPrReviewSubmissionBody({
			run_id: 'run-2906',
			pr_head_sha: 'abc123',
			coverage: { kind: 'FULL', unresolved_dimensions: [] },
			findings: [finding('T-201', { order_agreement: 'agree' })],
			order_unstable_suppressed: [
				finding('T-202', {
					status: 'DISPROVED',
					severity: 'NONE',
					order_agreement: 'agree',
				}),
			],
		});
		expect(result.body).not.toContain('Order-unstable (not published');
		expect(result.orderUnstableCount).toBe(0);
	});
});
