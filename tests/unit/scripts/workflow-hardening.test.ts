import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';

/**
 * Execution-boundary pins for the pr-standards job (issue #3282, absorbed by
 * #3290). The job executes PR-head-controlled TypeScript, so three properties
 * are load-bearing: the job is bounded, and no checkout leaves the job token
 * on disk for that code to read. A round-2 reviewer mutation (PR #3297)
 * deleted all three and every existing suite stayed green — this file is the
 * named falsifier #3282's acceptance criteria asked for.
 */

const root = path.resolve(import.meta.dir, '..', '..', '..');
const workflow = parse(
	readFileSync(
		path.join(root, '.github', 'workflows', 'pr-standards.yml'),
		'utf8',
	),
) as {
	jobs: Record<
		string,
		{
			'timeout-minutes'?: number;
			steps: Array<{
				name?: string;
				uses?: string;
				with?: Record<string, unknown>;
			}>;
		}
	>;
};

describe('pr-standards execution-boundary hardening (issue #3282)', () => {
	const job = workflow.jobs['pr-standards'];

	test('3290 the pr-standards job declares a timeout-minutes bound', () => {
		expect(typeof job['timeout-minutes']).toBe('number');
		expect(job['timeout-minutes'] as number).toBeGreaterThanOrEqual(1);
	});

	test('3290 every checkout in the pr-standards job sets persist-credentials false', () => {
		const checkouts = job.steps.filter((step) =>
			(step.uses ?? '').startsWith('actions/checkout'),
		);
		// The pull_request checkout (token otherwise persisted next to PR-head
		// code) and the workflow_dispatch checkout (added in #3276).
		expect(checkouts.length).toBe(2);
		for (const step of checkouts) {
			expect(step.with?.['persist-credentials']).toBe(false);
		}
	});
});
