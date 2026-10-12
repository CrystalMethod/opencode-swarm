// Issue #2906 — renderer surfaces for order-stability: the order-unstable
// marker, the result count, the summary line, and the zero-unstable absence
// guarantee (the token must not appear anywhere). Each finding carries a
// distinct location+evidence so the renderer's location-dedupe cannot
// consolidate them before the marker logic runs.
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
	file_line: `src/${id}.ts:12`,
	evidence: `evidence text for ${id}`,
	next_action: 'apply the required change',
	severity: 'HIGH',
	...overrides,
});

const render = (findings: readonly RendererFinding[]) =>
	renderPrReviewSubmissionBody({
		run_id: 'run-2906',
		pr_head_sha: 'abc123',
		coverage: { kind: 'FULL', unresolved_dimensions: [] },
		findings: [...findings],
	});

describe('renderer order-stability surfaces (issue #2906)', () => {
	test('disagreeing finding carries the marker; others do not', () => {
		const result = render([
			finding('T-101', { order_agreement: 'disagree' }),
			finding('T-102', { order_agreement: 'agree' }),
			finding('T-103'),
			finding('T-104', { order_agreement: 'single' }),
		]);
		const line = (id: string) =>
			result.body.split('\n').find((l) => l.includes(`[${id}]`));
		expect(line('T-101')).toBeDefined();
		expect(line('T-101') ?? '').toContain('order-unstable');
		expect(line('T-102') ?? '').not.toContain('order-unstable');
		expect(line('T-103') ?? '').not.toContain('order-unstable');
		expect(line('T-104') ?? '').not.toContain('order-unstable');
	});

	test('orderUnstableCount counts only disagreeing survivors', () => {
		const result = render([
			finding('T-101', { order_agreement: 'disagree' }),
			finding('T-102', { order_agreement: 'disagree' }),
			finding('T-103', { order_agreement: 'agree' }),
		]);
		expect(result.orderUnstableCount).toBe(2);
	});

	test('summary line counts unstable findings and carries no finding id', () => {
		const result = render([finding('T-101', { order_agreement: 'disagree' })]);
		const summary = result.body
			.split('\n')
			.find((l) => l.includes('order-unstable') && !l.includes('[T-'));
		expect(summary).toBeDefined();
		expect(summary ?? '').toMatch(/[0-9]/);
	});

	test('zero unstable findings: no marker, no summary, token absent entirely', () => {
		const result = render([
			finding('T-201'),
			finding('T-202', { order_agreement: 'single' }),
			finding('T-203', { order_agreement: 'agree' }),
		]);
		expect(result.body).not.toContain('order-unstable');
		expect(result.orderUnstableCount).toBe(0);
	});

	test('rendering stays pure: two renders are byte-identical', () => {
		const findings = [
			finding('T-301', { order_agreement: 'disagree' }),
			finding('T-302', { order_agreement: 'agree' }),
		];
		expect(render(findings)).toEqual(render(findings));
	});
});
