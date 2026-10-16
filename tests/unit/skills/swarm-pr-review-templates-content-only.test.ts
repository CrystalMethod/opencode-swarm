/**
 * AC16 (issue #3310) — prompt-templates.md Profile A fences are content-only.
 *
 * The four shared Profile A template fences (Reviewer, Critic, Base Explorer,
 * Micro-Lane/Council Explorer) must NOT carry `[REVIEWED] |`, `[CRITIC] |`,
 * `[CANDIDATE] |` or `[CLEAN] |` row-template text. On Profiles B/C the rows
 * remain the extraction contract, so each row format must live in a NEW,
 * separately headed section whose own markdown heading mentions Profile B/C.
 *
 * RED at base, GREEN after the fix.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_PATH = join(
	__dirname,
	'../../../.opencode/skills/swarm-pr-review/references/prompt-templates.md',
);

const TEMPLATE_HEADINGS = [
	'# Reviewer Prompt Template',
	'# Critic Prompt Template',
	'# Base Explorer Prompt Template',
	'# Micro-Lane / Council Explorer Prompt Template',
] as const;

const ROW_FORMAT_PATTERNS: readonly RegExp[] = [
	/\[REVIEWED\]\s*\|/,
	/\[CRITIC\]\s*\|/,
	/\[CANDIDATE\]\s*\|/,
	/\[CLEAN\]\s*\|/,
];

function readTemplates(): string {
	return readFileSync(TEMPLATES_PATH, 'utf-8');
}

/**
 * The first ```text fence under `heading`, bounded by the next level-1
 * heading so the Profile A template fences stay addressable even if the
 * Profile B/C row-format section adds its own subheadings or fences.
 */
function profileAFence(content: string, heading: string): string {
	const lines = content.split(/\r?\n/);
	const start = lines.findIndex((line) => line.startsWith(heading));
	expect(start).toBeGreaterThanOrEqual(0);
	let sectionEnd = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^#\s/.test(lines[i])) {
			sectionEnd = i;
			break;
		}
	}
	const fenceOpen = lines
		.slice(start, sectionEnd)
		.findIndex((line) => line.trim() === '```text');
	expect(fenceOpen).toBeGreaterThanOrEqual(0);
	const bodyStart = start + fenceOpen + 1;
	const fenceClose = lines
		.slice(bodyStart, sectionEnd)
		.findIndex((line) => line.trim() === '```');
	expect(fenceClose).toBeGreaterThanOrEqual(0);
	return lines.slice(bodyStart, bodyStart + fenceClose).join('\n');
}

/**
 * The section under the first markdown heading whose text mentions
 * "Profile B/C" (or "Profiles B and C"), up to the next heading of any
 * level. Returns undefined when no such heading exists.
 */
function profileBCSection(content: string): string | undefined {
	const lines = content.split(/\r?\n/);
	const headingIndex = lines.findIndex((line) =>
		/^#{1,6}\s.*(?:Profile B\/C|Profiles B and C)/i.test(line),
	);
	if (headingIndex < 0) return undefined;
	let sectionEnd = lines.length;
	for (let i = headingIndex + 1; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i])) {
			sectionEnd = i;
			break;
		}
	}
	return lines.slice(headingIndex, sectionEnd).join('\n');
}

describe('swarm-pr-review prompt templates (AC16, issue #3310)', () => {
	test('the template file keeps all four Profile A template headings', () => {
		const lines = readTemplates().split(/\r?\n/);
		for (const heading of TEMPLATE_HEADINGS) {
			expect(
				lines.some((line) => line.startsWith(heading)),
				`missing template heading: ${heading}`,
			).toBe(true);
		}
	});

	for (const heading of TEMPLATE_HEADINGS) {
		test(`Profile A fence under "${heading}" is content-only (no row-template text)`, () => {
			const fence = profileAFence(readTemplates(), heading);
			for (const pattern of ROW_FORMAT_PATTERNS) {
				expect(fence).not.toMatch(pattern);
			}
		});
	}

	test('a separately headed Profile B/C section carries all four row formats', () => {
		const section = profileBCSection(readTemplates());
		expect(section).toBeDefined();
		for (const pattern of ROW_FORMAT_PATTERNS) {
			expect(section ?? '').toMatch(pattern);
		}
	});
});
