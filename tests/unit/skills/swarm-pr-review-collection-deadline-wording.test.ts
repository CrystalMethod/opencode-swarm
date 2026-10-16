/**
 * AC19 (issue #3310) — a waited collection deadline is an observer deadline.
 *
 * prompt-templates.md currently claims "A waited collection deadline is
 * terminal: the controller makes one bounded partial-salvage attempt, then
 * records any still-active lane as error." That is false: per
 * src/background/pr-review-contract.ts, a waited collection deadline is an
 * OBSERVER deadline that never cancels or terminalizes child work. The fix
 * removes the terminal-deadline wording; the observer truth
 * (`collect_lane_results` is an OBSERVER) stays in SKILL.md.
 *
 * RED at base, GREEN after the fix.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_PATH = join(
	__dirname,
	'../../../.opencode/skills/swarm-pr-review/SKILL.md',
);
const TEMPLATES_PATH = join(
	__dirname,
	'../../../.opencode/skills/swarm-pr-review/references/prompt-templates.md',
);

/**
 * Frozen forbidden anchors. The first two MATCH at base in
 * prompt-templates.md (~:60-61); the third is the singular variant of the
 * same false claim and must never appear either.
 */
const FORBIDDEN_DEADLINE_PATTERNS: readonly {
	label: string;
	pattern: RegExp;
}[] = [
	{
		label: 'collection deadline declared terminal',
		pattern: /collection deadline is terminal/i,
	},
	{
		label: 'still-active lane recorded as error',
		pattern: /records any still-active lane as error/i,
	},
	{
		label: 'still-active lane recorded as error (singular)',
		pattern: /records? the still-active lane as error/i,
	},
];

function combinedText(): string {
	return `${readFileSync(SKILL_PATH, 'utf-8')}\n${readFileSync(TEMPLATES_PATH, 'utf-8')}`;
}

describe('swarm-pr-review collection deadline wording (AC19, issue #3310)', () => {
	test('no text claims a waited collection deadline terminalizes lanes', () => {
		const text = combinedText();
		for (const { label, pattern } of FORBIDDEN_DEADLINE_PATTERNS) {
			expect(
				pattern.test(text),
				`forbidden terminal-deadline wording still present: ${label}`,
			).toBe(false);
		}
	});

	test('the observer truth stays stated: collect_lane_results is an OBSERVER', () => {
		expect(combinedText()).toMatch(/`collect_lane_results` is an OBSERVER/i);
	});
});
