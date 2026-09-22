/** Acceptance coverage for issue #2490 / AC13. */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dir, '../../..');
const documentation = ['docs/memory.md', 'docs/commands.md']
	.map((relativePath) =>
		readFileSync(path.join(repositoryRoot, relativePath), 'utf8'),
	)
	.join('\n')
	.toLowerCase();

describe('issue #2490 AC13 — evaluator documentation and release evidence', () => {
	test('documents the profiles and auditable measurement contract', () => {
		for (const profile of ['lexical', 'hybrid', 'hybrid+rerank']) {
			expect(
				documentation,
				`missing profile documentation: ${profile}`,
			).toContain(profile);
		}
		for (const term of [
			'manifest',
			'corpus',
			'version',
			'limitation',
			'degrad',
			'fallback',
			'precision',
			'recall',
			'latency',
			'cost',
			'resource',
		]) {
			expect(
				documentation,
				`missing evaluator documentation term: ${term}`,
			).toContain(term);
		}
		for (const contractAnchor of [
			'--profiles lexical,hybrid,hybrid+rerank',
			'returned_token_estimate',
			'linux/macos/windows gate ids',
			'no model downloads or network access',
			'bun run check:retrieval-quality',
		]) {
			expect(
				documentation,
				`missing evaluator contract anchor: ${contractAnchor}`,
			).toContain(contractAnchor);
		}
	});

	test('has release evidence naming both issues (pending or materialized)', () => {
		const pendingDirectory = path.join(repositoryRoot, 'docs/releases/pending');
		const matches = readdirSync(pendingDirectory)
			.filter((file) => file.endsWith('.md'))
			.filter((file) => {
				const content = readFileSync(path.join(pendingDirectory, file), 'utf8');
				return content.includes('#2489') && content.includes('#2490');
			});
		if (matches.length > 0) {
			expect(
				matches,
				'expected one pending fragment mentioning #2489 and #2490',
			).toHaveLength(1);
			return;
		}
		// #2899: once the fragment is consumed by a shipped release, the
		// fragment cleanup materializes its content into docs/releases/v*.md
		// and removes the pending copy — the release evidence survives in the
		// archive instead of the pending directory.
		const releasesDirectory = path.join(repositoryRoot, 'docs/releases');
		const materialized = readdirSync(releasesDirectory)
			.filter((file) => file.startsWith('v') && file.endsWith('.md'))
			.filter((file) => {
				const content = readFileSync(path.join(releasesDirectory, file), 'utf8');
				return content.includes('#2489') && content.includes('#2490');
			});
		expect(
			materialized.length,
			'expected the #2489/#2490 release evidence to be pending or materialized in docs/releases',
		).toBeGreaterThanOrEqual(1);
	});
});
