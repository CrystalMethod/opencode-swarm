import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AutoReviewConfigSchema } from '../../../src/config/schema';
import type { ReviewDiffResult } from '../../../src/review/diff-source';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir';
import { _internals, runReviewEngine } from '../../../src/review/engine';

// Issue #2789: the review engine accumulates only KNOWN token contributions;
// an all-unknown dispatch set leaves evidence.cost token axes null instead of
// zero-filling, and known dispatch values still accumulate numerically.

const REVIEWER_TEXT = [
	'VERDICT: APPROVED',
	'RISK: LOW',
	'ISSUES: none',
	'```json',
	JSON.stringify({ findings: [], verdict: 'APPROVED' }),
	'```',
].join('\n');

let tmpDir: string;
const originalCollect = _internals.collectReviewDiff;

function diffStub(): Extract<ReviewDiffResult, { status: 'ok' }> {
	const canonicalText =
		'diff --git a/src/state.ts b/src/state.ts\n@@ -9,1 +10,1 @@\n-old\n+new\n';
	return {
		status: 'ok',
		selector: { kind: 'default' },
		canonicalText,
		reviewTextBytes: canonicalText.length,
		scopeHash: 'a'.repeat(64),
		headSha: 'b'.repeat(40),
		baseRef: 'origin/main',
		baseSha: 'c'.repeat(40),
		mergeBase: 'c'.repeat(40),
		changedLines: new Map([['src/state.ts', [{ start: 10, end: 10 }]]]),
		deletedLines: new Map([['src/state.ts', [{ start: 9, end: 9 }]]]),
		files: new Map([
			[
				'src/state.ts',
				{ kind: 'modified', oldPath: 'src/state.ts', newPath: 'src/state.ts' },
			],
		]),
		completeness: { complete: true, truncated: false, skipReasons: [] },
		staleness: {
			collectedAt: '2026-01-15T12:00:00.000Z',
			headSha: 'b'.repeat(40),
			selectorKey: 'default',
			includesWorkingTree: true,
			scopeHash: 'a'.repeat(64),
		},
		manifest: {
			schema_version: 2,
			hash: 'd'.repeat(64),
			content_hash: 'e'.repeat(64),
			selector: { kind: 'default' },
			selector_key: 'default',
			review_target_kind: 'checkout-history-index-working-tree',
			completeness: { complete: true, truncated: false, skip_reason_codes: [] },
			path_records: [],
		},
	};
}

async function runOnce(costFields: Record<string, unknown>): Promise<string> {
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	const result = await runReviewEngine({
		directory: tmpDir,
		sessionID: 'sess-2789',
		trigger: 'manual',
		config: AutoReviewConfigSchema.parse({
			enabled: true,
			validate_findings: false,
			final_review: { mode: 'advisory' },
		}),
		dispatcher: {
			async dispatch(request: { agentName: string; prompt: string }) {
				return {
					status: 'completed' as const,
					text: REVIEWER_TEXT,
					agentName: request.agentName,
					durationMs: 1,
					promptBytes: request.prompt.length,
					responseBytes: REVIEWER_TEXT.length,
					costFields,
				};
			},
		},
		reviewerAgent: 'reviewer',
		validatorAgent: 'critic_finding_validator',
		injectAdvisory: () => {},
	} as never);
	expect(result.evidencePath).toBeDefined();
	const evidence = JSON.parse(
		fs.readFileSync(result.evidencePath!, 'utf8'),
	) as { cost: Record<string, unknown> };
	return evidence.cost;
}

beforeEach(() => {
	tmpDir = canonicalMkdtemp('swarm-2789-engine-');
});

afterEach(() => {
	_internals.collectReviewDiff = originalCollect;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('review engine cost accumulation null policy (#2789)', () => {
	test('all-unknown dispatch set leaves token axes null', async () => {
		_internals.collectReviewDiff = (async () =>
			diffStub()) as unknown as typeof _internals.collectReviewDiff;
		const cost = await runOnce({
			tokens_input: null,
			tokens_output: null,
			tokens_reasoning: null,
			tokens_cache: null,
			cost_usd: null,
			cost_source: 'unavailable',
		});
		expect(cost['tokens_input']).toBeNull();
		expect(cost['tokens_output']).toBeNull();
		expect(cost['tokens_reasoning']).toBeNull();
		expect(cost['tokens_cache']).toBeNull();
	});

	test('known dispatch values still accumulate numerically', async () => {
		_internals.collectReviewDiff = (async () =>
			diffStub()) as unknown as typeof _internals.collectReviewDiff;
		const cost = await runOnce({
			tokens_input: 10,
			tokens_output: 5,
			tokens_reasoning: null,
			tokens_cache: null,
			cost_usd: null,
			cost_source: 'unavailable',
		});
		expect(cost['tokens_input']).toBe(10);
		expect(cost['tokens_output']).toBe(5);
		expect(cost['tokens_reasoning']).toBeNull();
	});
});
