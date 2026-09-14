/**
 * Issue #2756 regression tests — test_runner scope-guard remediation advice.
 *
 * The guard that rejects scope "convention"/"graph"/"impact" without
 * files/targets must direct the caller to provide files/targets and must NOT
 * recommend scope "all": that scope is blocked for agent use by the sibling
 * guard (SWARM_ALLOW_FULL_SUITE env-gated), so recommending it sends agents
 * into an unrecoverable loop (issue #2756 defect 1). Both response fields must
 * enumerate every scope the guard actually covers.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { test_runner } from '../../../src/tools/test-runner';

let savedAllowFullSuite: string | undefined;

beforeAll(() => {
	// Guard 1 opt-in must be absent so the sibling full-suite guard stays live;
	// the recommended workaround would be a proven dead end. Save and restore
	// so the shard's env state is untouched (PRR-009).
	savedAllowFullSuite = process.env.SWARM_ALLOW_FULL_SUITE;
	delete process.env.SWARM_ALLOW_FULL_SUITE;
});

afterAll(() => {
	if (savedAllowFullSuite === undefined) {
		delete process.env.SWARM_ALLOW_FULL_SUITE;
	} else {
		process.env.SWARM_ALLOW_FULL_SUITE = savedAllowFullSuite;
	}
});

describe('test_runner missing-files guard remediation advice (#2756)', () => {
	test('convention-without-files message directs to files/targets and never recommends scope "all"', async () => {
		const result = await test_runner.execute(
			{ scope: 'convention' },
			{} as any,
		);
		const parsed = JSON.parse(result) as {
			success?: boolean;
			message?: string;
			error?: string;
		};
		expect(parsed.success).toBe(false);
		expect(parsed.message ?? '').toMatch(/files|targets/i);
		expect(parsed.message ?? '').not.toContain('scope "all"');
		expect(parsed.error ?? '').not.toContain('scope "all"');
	});

	test('graph-without-files and impact-without-files return the same non-dead-end advice', async () => {
		for (const scope of ['graph', 'impact'] as const) {
			const result = await test_runner.execute({ scope }, {} as any);
			const parsed = JSON.parse(result) as { message?: string };
			expect(parsed.message ?? '').toMatch(/files|targets/i);
			expect(parsed.message ?? '').not.toContain('scope "all"');
		}
	});

	test('both response fields enumerate every scope the guard covers (PRR-007)', async () => {
		for (const scope of ['convention', 'graph', 'impact'] as const) {
			const result = await test_runner.execute({ scope }, {} as any);
			const parsed = JSON.parse(result) as {
				message?: string;
				error?: string;
			};
			expect(parsed.message ?? '').toContain('"impact"');
			expect(parsed.error ?? '').toContain('"impact"');
		}
	});

	test('guard 1 still blocks scope "all" for agent use (characterization)', async () => {
		const result = await test_runner.execute({ scope: 'all' }, {} as any);
		const parsed = JSON.parse(result) as { success?: boolean; error?: string };
		expect(parsed.success).toBe(false);
		expect(parsed.error ?? '').toContain('scope "all" is blocked');
	});

	test('guard 2 still rejects empty files arrays with the pinned error text', async () => {
		const result = await test_runner.execute(
			{ scope: 'convention', files: [] },
			{} as any,
		);
		const parsed = JSON.parse(result) as { error?: string };
		expect(parsed.error ?? '').toContain('require explicit files');
	});
});
