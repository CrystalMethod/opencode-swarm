import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	ContextBudgetConfigSchema,
	ScoringConfigSchema,
	ScoringWeightsSchema,
	TokenRatiosSchema,
} from '../../../src/config/schema.js';

/**
 * #2583 recurrence guardrail: every published `context_budget` JSON example
 * must validate against the schema that actually parses it. The pre-fix README
 * documented scoring weights keys (`recency`/`relevance`/`importance`) and a
 * `logs` token ratio that no schema declares — zod strips unknown keys and
 * injects defaults, so the published "tuning" examples configured nothing,
 * silently. This test derives the declared key sets from the schemas
 * themselves (never a hardcoded list) so it cannot silently agree with the
 * docs it checks.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const DOC_TARGETS = ['README.md', join('docs', 'installation.md')] as const;

// Declared keys derived from the schemas themselves.
const cbKeys = new Set(Object.keys(ContextBudgetConfigSchema.shape));
const scoringKeys = new Set(Object.keys(ScoringConfigSchema.shape));
const weightsKeys = new Set(Object.keys(ScoringWeightsSchema.shape));
const ratioKeys = new Set(Object.keys(TokenRatiosSchema.shape));
const weightsDefaults = ScoringWeightsSchema.parse({});

interface ExampleBlock {
	label: string;
	cb: Record<string, unknown>;
}

function collectContextBudgetBlocks(rel: string): ExampleBlock[] {
	const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
	const blocks = [...text.matchAll(/```json\r?\n([\s\S]*?)```/g)]
		.map((m) => m[1])
		.filter((b) => b.includes('context_budget'));
	return blocks.flatMap((block, index) => {
		const parsed = JSON.parse(block) as {
			context_budget?: Record<string, unknown>;
		};
		// A json block mentioning context_budget without a context_budget
		// object (e.g. quoting the key in prose inside json) is not an example.
		if (!parsed.context_budget) return [];
		return [
			{ label: `${rel} json-block ${index + 1}`, cb: parsed.context_budget },
		];
	});
}

function sortedJson(v: unknown): string {
	if (v === null || typeof v !== 'object') return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`;
	const entries = Object.entries(v as Record<string, unknown>).sort(
		([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
	);
	return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${sortedJson(val)}`).join(',')}}`;
}

describe('published context_budget examples validate against the schema (#2583)', () => {
	const examples = DOC_TARGETS.flatMap(collectContextBudgetBlocks);

	test('context_budget json examples exist in the documented surfaces', () => {
		expect(examples.length).toBeGreaterThan(0);
	});

	test.each(
		examples.map((e) => [e.label, e] as const),
	)('%s uses only declared schema keys', (_label, example) => {
		const cb = example.cb;
		for (const k of Object.keys(cb)) {
			expect(cbKeys.has(k)).toBe(true);
		}
		const scoring = cb.scoring as Record<string, unknown> | undefined;
		if (!scoring) return;
		for (const k of Object.keys(scoring)) {
			expect(scoringKeys.has(k)).toBe(true);
		}
		for (const k of Object.keys(
			(scoring.weights as Record<string, unknown>) ?? {},
		)) {
			expect(weightsKeys.has(k)).toBe(true);
		}
		for (const k of Object.keys(
			(scoring.token_ratios as Record<string, unknown>) ?? {},
		)) {
			expect(ratioKeys.has(k)).toBe(true);
		}
	});

	test.each(
		examples.map((e) => [e.label, e] as const),
	)('%s parses successfully and published weights are effective (not a stripped no-op)', (_label, example) => {
		const result = ContextBudgetConfigSchema.safeParse(example.cb);
		expect(result.success).toBe(true);
		if (!result.success) return;
		const scoring = (example.cb as { scoring?: { weights?: unknown } }).scoring;
		if (!scoring?.weights) return;
		const rawWeights = Object.keys(scoring.weights as Record<string, unknown>);
		const parsedWeights = result.data.scoring?.weights as
			| Record<string, number>
			| undefined;
		if (!parsedWeights || rawWeights.length === 0) return;
		// A weights example whose every raw key is stripped by zod parses to
		// pure defaults — the documented "tuning" configures nothing.
		expect(sortedJson(parsedWeights)).not.toBe(sortedJson(weightsDefaults));
	});
});

describe('masking-condition documentation matches the runtime predicate (#2583 final-critic)', () => {
	// Runtime: shouldMaskToolOutput (src/hooks/context-budget.ts) masks a
	// completed tool output in a non-protected turn when it is older than
	// recent_window OR longer than tool_output_mask_threshold — either
	// condition suffices. The first fix draft wrongly documented a
	// conjunction ("longer than this — and older than recent_window");
	// this pins the OR joiner in every surface that documents the condition.
	const surfaces = [
		'README.md',
		join('docs', 'installation.md'),
		join('docs', 'architecture.md'),
	] as const;
	const orJoiner =
		/older than[^.|]*\bor\b[^.|]*longer than|longer than[^.|]*\bor\b[^.|]*older than/i;

	test.each(
		surfaces,
	)('%s documents the masking predicate as OR, not AND', (rel) => {
		const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
		const mentions = text
			.split('\n')
			.filter((line) => line.includes('tool_output_mask_threshold'));
		// At least one line per surface must state the condition, and every
		// line that states age+size together must join them with OR.
		expect(mentions.length).toBeGreaterThan(0);
		const statingAgeAndSize = mentions.filter(
			(line) => /older than/i.test(line) && /longer than/i.test(line),
		);
		expect(statingAgeAndSize.length).toBeGreaterThan(0);
		for (const line of statingAgeAndSize) {
			expect(orJoiner.test(line)).toBe(true);
		}
	});
});
