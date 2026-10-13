import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Issue #3098 check C4 (DISCRIMINATING). The `write_pr_review_artifact` tool
 * description lacks the reviewer `UNVERIFIED → PENDING` ledger mapping
 * documented at .opencode/skills/swarm-pr-review/references/
 * findings-persistence-contract.md:75 ("UNVERIFIED | `PENDING` |
 * `route_to_reviewer`"). A reviewer lane reading only the tool description has
 * no way to know an UNVERIFIED verdict persists as a PENDING record; the fix
 * documents the mapping.
 *
 * SURFACE INVESTIGATION (documented per the trace plan): the description
 * exists as TWO independent literals that do NOT derive from each other —
 *  (1) the `createSwarmTool({ description: ... })` literal at
 *      src/tools/write-pr-review-artifact.ts (the runtime tool object), and
 *  (2) the `TOOL_METADATA` entry at src/tools/tool-metadata.ts (the help/
 *      agent-map surface).
 * They are hand-maintained mirrors (they differ only in case/trailing
 * period), so the check asserts BOTH surfaces: updating one and not the other
 * is exactly the drift this check exists to prevent.
 *
 * Verified ABSENT at base: neither file contains 'UNVERIFIED' anywhere
 * (zero occurrences in both files).
 */

function source(relativePath: string): string {
	return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

/** The description literal that follows the given anchor declaration. */
function descriptionRegion(source: string, anchor: string): string {
	const anchorIndex = source.indexOf(anchor);
	if (anchorIndex === -1) return '';
	const descriptionIndex = source.indexOf('description:', anchorIndex);
	if (descriptionIndex === -1) return '';
	const candidateEnds = [
		source.indexOf('args:', descriptionIndex),
		source.indexOf('agents:', descriptionIndex),
	].filter((index) => index !== -1);
	const end = candidateEnds.length ? Math.min(...candidateEnds) : source.length;
	return source.slice(descriptionIndex, end);
}

function assertDocumentsUnverifiedToPending(region: string): void {
	expect(region).not.toBe('');
	const unverified = region.indexOf('UNVERIFIED');
	const pending = region.indexOf('PENDING');
	expect(unverified).toBeGreaterThanOrEqual(0);
	expect(pending).toBeGreaterThanOrEqual(0);
	// The mapping must be stated as one documented fact, not two unrelated
	// mentions: both vocabulary tokens near each other in the description.
	expect(Math.abs(unverified - pending)).toBeLessThanOrEqual(200);
}

describe('write_pr_review_artifact description documents the UNVERIFIED mapping (issue #3098)', () => {
	test('the runtime tool description documents UNVERIFIED persisting as PENDING', () => {
		const toolSource = source('src/tools/write-pr-review-artifact.ts');
		const region = descriptionRegion(
			toolSource,
			'export const write_pr_review_artifact',
		);
		// Sanity anchor: the description surface exists (it does at base).
		expect(region).toContain('findings checkpoints');
		assertDocumentsUnverifiedToPending(region);
	});

	test('the TOOL_METADATA mirror description documents the same mapping', () => {
		const metadataSource = source('src/tools/tool-metadata.ts');
		const region = descriptionRegion(
			metadataSource,
			'write_pr_review_artifact:',
		);
		// Sanity anchor: the metadata description surface exists (it does at base).
		expect(region).toContain('findings checkpoints');
		assertDocumentsUnverifiedToPending(region);
	});
});
