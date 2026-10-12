import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Issue #3098 check C3 (DISCRIMINATING). The architect PR_REVIEW prompt gives
 * discovery lanes a settlement contract (the SETTLE DISCOVERY LANES bullet)
 * but the reviewer/critic bullet ("RUN HEAD-BOUND VALIDATION: ...") is
 * dispatch-mechanics only: it never tells the lane WHAT a correct
 * `[REVIEWED]`/`[CRITIC]` artifact is. The fix adds contract sentences to that
 * bullet: the marker contract, exact-row coverage semantics (one row per
 * assigned item id, exact marker format), and that trailing non-contract
 * summary rows (e.g. `task-unknown`) fail settlement.
 *
 * Assertion substrings are deliberately semantic (the implementer may satisfy
 * them with reasonable wording) but verified ABSENT at base:
 * - '[REVIEWED]' / '[CRITIC]'   — the marker contract is named
 * - 'one row per'               — exact-row coverage semantics
 * - 'trailing'                  — trailing non-contract summary rows are named
 * - /fail|reject/               — the consequence (settlement failure) is stated
 *
 * Mirrors the source-pinning pattern of
 * tests/unit/agents/architect-pr-review-dispatch-guidance.test.ts.
 */

function reviewerCriticPromptRegion(): string {
	const source = readFileSync(
		join(process.cwd(), 'src/agents/architect.ts'),
		'utf8',
	);
	const start = source.indexOf('RUN HEAD-BOUND VALIDATION');
	if (start === -1) return '';
	const end = source.indexOf('COMPLETE EXPLICITLY', start);
	return source.slice(start, end === -1 ? undefined : end);
}

describe('architect reviewer/critic verdict settlement contract (issue #3098)', () => {
	test('the RUN HEAD-BOUND VALIDATION bullet names the marker contract', () => {
		const region = reviewerCriticPromptRegion();
		// Sanity anchor: the bullet itself must exist (it does at base).
		expect(region).toContain('swarm-pr-review:reviewer');
		expect(region).toContain('swarm-pr-review:critic');
		// The fix's contract: the bullet must name the verdict markers a correct
		// reviewer/critic artifact is built from.
		expect(region).toContain('[REVIEWED]');
		expect(region).toContain('[CRITIC]');
	});

	test('the bullet states exact-row coverage semantics for the assigned items', () => {
		const region = reviewerCriticPromptRegion();
		expect(region).toContain('one row per');
	});

	test('the bullet states that trailing non-contract summary rows fail settlement', () => {
		const region = reviewerCriticPromptRegion();
		expect(region).toContain('trailing');
		expect(region).toMatch(/fail|reject/);
	});
});
