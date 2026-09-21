/**
 * Issue #2733 — the four module-local canonicalGitHubPrUrl copies
 * (pr-event-subscribers, pr-feedback-event-queue, pr-workflow-response-gate,
 * pr-workflow-gate) must delegate to the shared canonicalForgePrUrl instead
 * of reimplementing GitHub-only canonicalization. The module-local functions
 * are not exported, so delegation is pinned two ways: canonicalForgePrUrl
 * matches the frozen corpus those consumers depend on, and a static source
 * assertion requires the delegation return inside each consumer.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalForgePrUrl } from '../../../src/providers/forge-provider.js';

const repoRoot = path.resolve(import.meta.dir, '..', '..', '..');

const CONSUMER_MODULES = [
	'src/background/pr-event-subscribers.ts',
	'src/background/pr-feedback-event-queue.ts',
	'src/hooks/pr-workflow-response-gate.ts',
	'src/hooks/pr-workflow-gate.ts',
] as const;

/** Shared corpus: github positive, github case/trailing slash, gitlab MR, gitlab self-hosted, issues→null, generic→null, http→null. */
const CORPUS: Array<[string, string | null]> = [
	['https://github.com/owner/repo/pull/42', 'github.com/owner/repo/pull/42'],
	['https://GitHub.com/Owner/Repo/pull/42/', 'github.com/owner/repo/pull/42'],
	[
		'https://gitlab.com/acme/app/-/merge_requests/155',
		'gitlab.com/acme/app/-/merge_requests/155',
	],
	[
		'https://gitlab.acme.test/Ops/Infra/Platform/-/merge_requests/7',
		'gitlab.acme.test/ops/infra/platform/-/merge_requests/7',
	],
	['https://gitlab.com/acme/app/-/issues/42', null],
	['https://example.com/owner/repo/pull/1', null],
	['http://gitlab.com/acme/app/-/merge_requests/1', null],
];

describe('canonicalGitHubPrUrl delegation (#2733)', () => {
	test('canonicalForgePrUrl matches the frozen corpus the four consumers rely on', () => {
		for (const [input, expected] of CORPUS) {
			expect(canonicalForgePrUrl(input)).toBe(expected);
		}
	});

	test('every consumer keeps a module-local canonicalGitHubPrUrl that delegates to canonicalForgePrUrl', () => {
		for (const rel of CONSUMER_MODULES) {
			const source = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
			expect(
				source.includes('function canonicalGitHubPrUrl('),
				`${rel} must still define the module-local canonicalGitHubPrUrl`,
			).toBe(true);
			expect(
				source.includes('return canonicalForgePrUrl(value);'),
				`${rel} must delegate, not reimplement`,
			).toBe(true);
		}
	});
});
