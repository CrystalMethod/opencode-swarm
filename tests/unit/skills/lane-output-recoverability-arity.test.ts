/**
 * AC20 (issue #3310) — the canonical `[REVIEWED]` arity is 12-field.
 *
 * lane-output-recoverability.md currently claims "`[REVIEWED]` (10-field)"
 * (~:61). The canonical arity is 12 (legacy 10-field rows are accepted via
 * normalization at the parse boundary). The fix corrects the arity
 * description while keeping the `[CRITIC]` (6-field) and
 * `[FEEDBACK-VERIFIED]` (4-field) mentions intact.
 *
 * Satisfying shape for the corrected sentence (the frozen anchors below
 * define it): `12-field` within 40 chars after `[REVIEWED]` on the arity
 * line, and the legacy `10-field` mention either more than 40 chars after
 * `[REVIEWED]` on that line or on one of the two following lines, e.g.
 * "`[REVIEWED]` (12-field), `[CRITIC]` (6-field), ... rows tail-merge ...
 * Legacy 10-field rows are accepted via normalization at the parse
 * boundary." A `10-field` mention inside the 40-char shadow of
 * `[REVIEWED]` still reads as the false canonical claim and stays RED.
 *
 * RED at base, GREEN after the fix.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DOC_PATH = join(
	__dirname,
	'../../../.opencode/skills/swarm-pr-review/references/lane-output-recoverability.md',
);

const FALSE_ARITY_PATTERN = /\[REVIEWED\][^\n]{0,40}10-field/;
const CANONICAL_ARITY_PATTERN = /\[REVIEWED\][^\n]{0,40}12-field/;

function readDoc(): string {
	return readFileSync(DOC_PATH, 'utf-8');
}

/** The line carrying the corrected `[REVIEWED]` arity, plus the two following lines. */
function reviewedArityWindow(content: string): string {
	const lines = content.split(/\r?\n/);
	const idx = lines.findIndex((line) => CANONICAL_ARITY_PATTERN.test(line));
	expect(idx).toBeGreaterThanOrEqual(0);
	return lines.slice(idx, idx + 3).join('\n');
}

describe('lane-output recoverability REVIEWED arity (AC20, issue #3310)', () => {
	test('the [REVIEWED] arity is not described as the false 10-field canonical arity', () => {
		expect(readDoc()).not.toMatch(FALSE_ARITY_PATTERN);
	});

	test('the [REVIEWED] arity is described as canonical 12-field', () => {
		expect(readDoc()).toMatch(CANONICAL_ARITY_PATTERN);
	});

	test('the legacy 10-field acceptance is mentioned near the corrected arity', () => {
		const window = reviewedArityWindow(readDoc());
		expect(window).toMatch(/legacy/i);
		expect(window).toMatch(/10-field/);
	});

	test('guard: the [CRITIC] 6-field arity mention survives', () => {
		expect(readDoc()).toMatch(/\[CRITIC\][^\n]{0,20}6-field/);
	});

	test('guard: the [FEEDBACK-VERIFIED] 4-field arity mention survives', () => {
		const lines = readDoc().split(/\r?\n/);
		const idx = lines.findIndex((line) => line.includes('[FEEDBACK-VERIFIED]'));
		expect(idx).toBeGreaterThanOrEqual(0);
		// base wraps the arity count onto the next line; allow same or next line
		const window = lines.slice(idx, idx + 2).join('\n');
		expect(window).toMatch(/4-field/);
	});
});
