import { describe, expect, test } from 'bun:test';
import {
	PR_REVIEW_INLINE_COMMENT_CAP,
	type RendererFinding,
	renderPrReviewSubmissionBody,
} from '../../../src/pr-review/render-review-body.js';

function finding(
	id: string,
	severity: RendererFinding['severity'],
	fileLine: string,
	evidence = `evidence for ${id}`,
): RendererFinding {
	return {
		finding_id: id,
		status: 'CONFIRMED',
		file_line: fileLine,
		evidence,
		next_action: 'report',
		severity,
	};
}

function input(findings: RendererFinding[], existingComments?: string[]) {
	return {
		run_id: 'render-run',
		pr_head_sha: 'abc123',
		verdict: 'REQUEST_CHANGES',
		coverage: { kind: 'FULL', unresolved_dimensions: [] },
		findings,
		...(existingComments ? { existingComments } : {}),
	};
}

describe('renderPrReviewSubmissionBody', () => {
	test('groups by severity in descending order regardless of input order', () => {
		const rendered = renderPrReviewSubmissionBody(
			input([
				finding('LOW-1', 'LOW', 'src/low.ts:12'),
				finding('HIGH-1', 'HIGH', 'src/high.ts:3'),
				finding('MED-1', 'MEDIUM', 'src/med.ts:7'),
			]),
		);
		const high = rendered.body.indexOf('HIGH-1');
		const medium = rendered.body.indexOf('MED-1');
		const low = rendered.body.indexOf('LOW-1');
		expect(high).toBeGreaterThan(-1);
		expect(medium).toBeGreaterThan(high);
		expect(low).toBeGreaterThan(medium);
	});

	test('renders only non-empty severity groups', () => {
		const rendered = renderPrReviewSubmissionBody(
			input([finding('ONLY-1', 'LOW', 'src/only.ts:1')]),
		);
		expect(rendered.body).not.toContain('CRITICAL');
		expect(rendered.body).not.toContain('MEDIUM');
		expect(rendered.body).toContain('ONLY-1');
		expect(rendered.body).toContain('src/only.ts:1');
	});

	test('discloses partial coverage with unresolved dimension names', () => {
		const rendered = renderPrReviewSubmissionBody({
			run_id: 'render-run',
			pr_head_sha: 'abc123',
			coverage: {
				kind: 'PARTIAL',
				unresolved_dimensions: ['security-trust', 'reliability-performance'],
			},
			findings: [finding('P-1', 'HIGH', 'src/p.ts:2')],
		});
		expect(rendered.body).toContain('PARTIAL');
		expect(rendered.body).toContain('security-trust');
		expect(rendered.body).toContain('reliability-performance');
	});

	test('parses file:line locations into inline comments', () => {
		const rendered = renderPrReviewSubmissionBody(
			input([finding('L-1', 'HIGH', 'src/a/b.ts:42')]),
		);
		expect(rendered.inlineComments).toHaveLength(1);
		expect(rendered.inlineComments[0]?.path).toBe('src/a/b.ts');
		expect(rendered.inlineComments[0]?.line).toBe(42);
		expect(rendered.inlineComments[0]?.finding_id).toBe('L-1');
	});

	test('findings without a parseable location stay body-only', () => {
		const rendered = renderPrReviewSubmissionBody(
			input([finding('N-1', 'LOW', 'no-location-here')]),
		);
		expect(rendered.inlineComments).toHaveLength(0);
		expect(rendered.body).toContain('N-1');
		expect(rendered.body).toContain('no-location-here');
	});

	test('is pure: identical repeat output and no input mutation', () => {
		const value = input([
			finding('D-1', 'HIGH', 'src/d.ts:1'),
			finding('D-2', 'LOW', 'src/d2.ts:2'),
		]);
		const snapshot = structuredClone(value);
		const first = renderPrReviewSubmissionBody(value);
		const second = renderPrReviewSubmissionBody(value);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
		expect(value).toEqual(snapshot);
	});

	test('consolidates repeated finding ids and identical locations', () => {
		const rendered = renderPrReviewSubmissionBody(
			input([
				finding('DUP', 'HIGH', 'src/dup.ts:5', 'same'),
				finding('DUP', 'HIGH', 'src/dup.ts:5', 'same'),
				finding('A', 'MEDIUM', 'src/same.ts:9', 'same'),
				finding('B', 'MEDIUM', 'src/same.ts:9', 'same'),
				finding('KEEP', 'LOW', 'src/keep.ts:2'),
			]),
		);
		const ids = rendered.inlineComments.map((comment) => comment.finding_id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.filter((id) => id === 'DUP')).toHaveLength(1);
		const sameLocation = rendered.inlineComments.filter(
			(comment) => comment.path === 'src/same.ts' && comment.line === 9,
		);
		expect(sameLocation).toHaveLength(1);
		expect(ids).toContain('KEEP');
	});

	test('skips findings whose rendered marker already appears in existing comments', () => {
		const rendered = renderPrReviewSubmissionBody(
			input(
				[
					finding('POSTED', 'HIGH', 'src/p.ts:4'),
					finding('FRESH', 'LOW', 'src/f.ts:8'),
				],
				// The marker is the exact rendered prefix this renderer emits.
				['earlier review comment: [POSTED] already posted evidence'],
			),
		);
		expect(rendered.inlineComments.some((c) => c.finding_id === 'POSTED')).toBe(
			false,
		);
		expect(rendered.inlineComments.some((c) => c.finding_id === 'FRESH')).toBe(
			true,
		);
		expect(rendered.skippedAsPosted).toEqual(['POSTED']);
	});

	test('does not suppress on bare-id or substring collisions (PRR-003/PRR-007)', () => {
		const rendered = renderPrReviewSubmissionBody(
			input(
				[
					finding('HIGH-1', 'HIGH', 'src/h1.ts:1'),
					finding('T-1', 'LOW', 'src/t1.ts:2'),
				],
				// A bare id mention and a longer id both existed on the PR; neither
				// is the rendered marker for these findings, so neither suppresses.
				['someone commented about HIGH-11 and T-10 earlier'],
			),
		);
		expect(rendered.skippedAsPosted).toEqual([]);
		expect(rendered.inlineComments).toHaveLength(2);
	});

	test('caps inline comments and discloses the truncation', () => {
		const findings = Array.from(
			{ length: PR_REVIEW_INLINE_COMMENT_CAP + 5 },
			(_, i) =>
				finding(
					`CAP-${String(i + 1).padStart(2, '0')}`,
					'HIGH',
					`src/c${i}.ts:${i + 1}`,
				),
		);
		const rendered = renderPrReviewSubmissionBody(input(findings));
		expect(rendered.inlineComments).toHaveLength(PR_REVIEW_INLINE_COMMENT_CAP);
		expect(rendered.truncatedInlineComments).toBe(5);
		expect(/truncat/i.test(rendered.body)).toBe(true);
		// The body still lists every finding even when inline comments are capped.
		for (const item of findings) {
			expect(rendered.body).toContain(item.finding_id);
		}
	});
});
