/**
 * AC18 (issue #3310) — verdict rows are accepted anywhere in the response.
 *
 * SKILL.md and references/prompt-templates.md must stop mandating the
 * verdict row as the FINAL line of a reviewer/critic response (no
 * "must end with", no "planning preamble" re-dispatch framing, no
 * "REQUIRED FINAL LINE"). Instead the skill states that rows are accepted
 * anywhere in the response, exactly one per assigned ID, with no other
 * line beginning with the marker.
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
 * Frozen forbidden anchors. Each one MATCHES at base and must be absent
 * after the fix — the fix removes the final-line row mandate from every
 * place it currently appears (reviewer row requirement, critic verdict-row
 * contract, re-dispatch trigger, REQUIRED FINAL LINE template block).
 */
const FORBIDDEN_ROW_POSITION_PATTERNS: readonly {
	label: string;
	pattern: RegExp;
}[] = [
	{
		label: 'reviewer response must-end-with mandate',
		pattern: /must end with one parseable/i,
	},
	{
		label: 'critic does-not-end-with rejection',
		pattern: /does not end with that exact row/i,
	},
	{
		label: 'planning-preamble framing',
		pattern: /planning preamble/i,
	},
	{
		label: 'REQUIRED FINAL LINE template instruction',
		pattern: /REQUIRED FINAL LINE/i,
	},
	{
		label: 'final-line-MUST-be-exactly instruction',
		pattern: /final line MUST be exactly/i,
	},
	{
		label: 're-dispatch explicit final-line instruction',
		pattern: /re-dispatch that lane with the explicit instruction/i,
	},
];

function combinedText(): string {
	return `${readFileSync(SKILL_PATH, 'utf-8')}\n${readFileSync(TEMPLATES_PATH, 'utf-8')}`;
}

describe('swarm-pr-review verdict row position (AC18, issue #3310)', () => {
	test('no text mandates the verdict row as the final line of a response', () => {
		const text = combinedText();
		for (const { label, pattern } of FORBIDDEN_ROW_POSITION_PATTERNS) {
			expect(
				pattern.test(text),
				`forbidden final-line row-position wording still present: ${label}`,
			).toBe(false);
		}
	});

	test('rows-anywhere acceptance is stated', () => {
		expect(combinedText()).toMatch(
			/rows?\s+(are|is)\s+accepted\s+anywhere\s+in\s+the\s+response/i,
		);
	});

	test('exactly one row per assigned ID is stated', () => {
		expect(combinedText()).toMatch(/exactly one[^\n]{0,40}(row|live)/i);
	});
});
