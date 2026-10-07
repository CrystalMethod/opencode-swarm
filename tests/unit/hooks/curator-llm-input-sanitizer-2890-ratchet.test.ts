/**
 * Source ratchet for #2890 (split from curator-llm-input-sanitizer-2890.test.ts
 * for the FR-006 line cap): every sanitizeContextText application in the
 * curator family must be present and load-bearing. Function bodies are
 * located by name marker + paren-aware brace walk, which matches the
 * non-exported assembleLLMInput/repairPostMortemActions.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeContextText } from '../../../src/hooks/context-sanitizer';

describe('curator sanitizer source ratchet (#2890)', () => {
	it('source ratchet: every sanitizer application is present and load-bearing', () => {
		const curatorSource = readFileSync(
			join(import.meta.dir, '../../../src/hooks/curator.ts'),
			'utf8',
		);
		const pmSource = readFileSync(
			join(import.meta.dir, '../../../src/hooks/curator-postmortem.ts'),
			'utf8',
		);

		// Paren-aware brace walk: signature type annotations contain braces
		// (`knowledgeConfig: { directory?: string }`, `Array<{ ... }>`) that
		// must not be taken as the body opener.
		function functionBody(source: string, startMarker: string): string {
			const idx = source.indexOf(startMarker);
			expect(idx).toBeGreaterThanOrEqual(0);
			let parenDepth = 0;
			let open = -1;
			const searchStart = source.indexOf('(', idx);
			for (let i = searchStart; i >= 0 && i < source.length; i++) {
				const ch = source[i];
				if (ch === '(') parenDepth++;
				else if (ch === ')') parenDepth--;
				else if (ch === '{' && parenDepth === 0) {
					open = i;
					break;
				}
			}
			expect(open).toBeGreaterThanOrEqual(0);
			let depth = 0;
			for (let i = open; i < source.length; i++) {
				const ch = source[i];
				if (ch === '{') depth++;
				else if (ch === '}') {
					depth--;
					if (depth === 0) return source.slice(open, i + 1);
				}
			}
			throw new Error(`unbalanced body for ${startMarker}`);
		}

		function expectLoadBearing(body: string, name: string): void {
			const match = body.match(/(\w+)\s*=\s*sanitizeContextText\(/);
			const bindingConsumed =
				match !== null &&
				match.index !== undefined &&
				match[1] !== undefined &&
				body.indexOf(match[1], match.index + match[0].length) !== -1;
			const sanitizedReturn = /return\s+sanitizeContextText\(/.test(body);
			expect(
				bindingConsumed || sanitizedReturn,
				`${name} must apply sanitizeContextText load-bearingly`,
			).toBe(true);
		}

		expect(curatorSource).toMatch(/from '\.\/context-sanitizer(\.js)?';/);
		const phaseBody = functionBody(
			curatorSource,
			'export async function runCuratorPhase',
		);
		expectLoadBearing(phaseBody, 'runCuratorPhase userInput');
		expect(phaseBody).toMatch(/sanitizeContextText\(\s*decision\.raw/);
		// Field-level pins (#2890 PRR-001): label-interpolated blobs must be
		// sanitized before composition or a line-1 directive goes mid-line.
		const initBody = functionBody(
			curatorSource,
			'export async function runCuratorInit',
		);
		const assembleBody = functionBody(pmSource, 'function assembleLLMInput');
		const fieldLevelPins: Array<[string, string, RegExp]> = [
			[
				'runCuratorPhase',
				phaseBody,
				/PRIOR_DIGEST: \$\{sanitizeContextText\(priorDigest\)\}/,
			],
			[
				'runCuratorInit',
				initBody,
				/PROJECT_CONTEXT: \$\{sanitizeContextText\(contextMd\?\.slice\(/,
			],
			[
				'runCuratorInit',
				initBody,
				/POST_MORTEM_DIGEST: \$\{sanitizeContextText\(latestPostMortemDigest \?\? 'none'\)\}/,
			],
			[
				'assembleLLMInput',
				assembleBody,
				/PLAN_SUMMARY: \$\{sanitizeContextText\(planSummary\)\}/,
			],
			[
				'assembleLLMInput',
				assembleBody,
				/CURATOR_DIGESTS: \$\{sanitizeContextText\(curatorDigest \?\? 'none'\)\}/,
			],
		];
		for (const [fn, body, pattern] of fieldLevelPins) {
			expect(body, `${fn} field-level sanitize pin`).toMatch(pattern);
		}
		expectLoadBearing(initBody, 'runCuratorInit userInput');
		expect(assembleBody).toMatch(/return\s+sanitizeContextText\(/);
		const repairBody = functionBody(
			pmSource,
			'async function repairPostMortemActions',
		);
		expect(repairBody).toMatch(/sanitizeContextText\(\s*llmOutput\s*\)/);
		// Diagnostics are sanitized per-element so every element is
		// line-anchored, not just the first (#2890 review PRR-004).
		expect(repairBody).toMatch(
			/diagnostics\.map\(\(d\) => sanitizeContextText\(d\)\)\.join\('; '\)/,
		);
		// The literal instruction fence must NOT be routed through the
		// sanitizer (it would corrupt the ``` sequence the repair round
		// depends on).
		expect(repairBody).not.toMatch(
			/sanitizeContextText\(\s*\[\s*'Repair the supplied/,
		);
		expect(sanitizeContextText('```json x')).not.toContain('```');
	});
});
