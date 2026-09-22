import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Issue #2789 guardrail ratchet: the legacy cost family must stay
// null-preserving. This source-scan pins the zero-survivor property over the
// cost-family files — reintroducing a `?? 0` / `||= ... ?? 0` fold or a
// `typeof x === 'number' ? x : 0` collapse on a token axis fails here.
//
// Single documented exception: `costSnapshotDigest` in
// src/services/cost-accounting.ts canonicalizes unknown (null) to 0 for
// digest stability with pre-#2789 lines (see the in-place comment there);
// exactly 4 folded-token occurrences are pinned for that function.

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');

const COST_FAMILY_FILES: readonly string[] = [
	'src/telemetry.ts',
	'src/services/cost-accounting.ts',
	'src/review/engine.ts',
	'src/review/evidence.ts',
	'src/commands/costs.ts',
	'src/commands/review.ts',
	'src/background/delegation-lifecycle.ts',
	'src/index.ts',
];

/** Token-axis fold-to-zero shapes (#2789 defect class). */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
	{
		name: 'tokens_* ?? 0 fold',
		re: /tokens_(?:input|output|reasoning|cache)\s*\?\?\s*0\b/,
	},
	{
		name: 'readFiniteNonNegative(...) ?? 0 fold',
		re: /readFiniteNonNegative\([^;{}]*\)\s*\?\?\s*0\b/,
	},
	{
		name: '||= ... ?? 0 token fold',
		re: /tokens_(?:input|output|reasoning|cache)\s*\|\|=\s*[^;\n]*\?\?\s*0\b/,
	},
	{
		name: "typeof tokens_* === 'number' ? x : 0 collapse",
		re: /tokens_(?:input|output|reasoning|cache)[^;\n]*===\s*'number'[^;\n]*:\s*0\b/,
	},
];

describe('cost null-default ratchet (#2789)', () => {
	/** Strip the single documented digest exception from the scanned text. */
	function scanned(rel: string): string {
		let text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
		if (rel.endsWith('cost-accounting.ts')) {
			const start = text.indexOf('function costSnapshotDigest');
			const end = text.indexOf('\n}', start);
			text = text.slice(0, start) + text.slice(end);
		}
		return text;
	}

	test('cost family files contain no token-axis zero-default folds', () => {
		const violations: string[] = [];
		for (const rel of COST_FAMILY_FILES) {
			const text = scanned(rel);
			for (const { name, re } of FORBIDDEN_PATTERNS) {
				const match = re.exec(text);
				if (match) {
					const line = text.slice(0, match.index).split('\n').length;
					violations.push(`${rel}:${line} ${name}`);
				}
			}
		}
		expect(
			violations,
			`#2789 zero-default reintroduction: ${violations.join('; ')}`,
		).toEqual([]);
	});

	test('digest canonicalization keeps exactly its pinned null-to-0 folds', () => {
		const text = fs.readFileSync(
			path.join(REPO_ROOT, 'src/services/cost-accounting.ts'),
			'utf8',
		);
		const fnStart = text.indexOf('function costSnapshotDigest');
		expect(fnStart).toBeGreaterThanOrEqual(0);
		const body = text.slice(fnStart, text.indexOf('\n}', fnStart));
		const folds = [
			...body.matchAll(
				/tokens_(?:input|output|reasoning|cache)[^;\n]*\?\?\s*0\b/g,
			),
		];
		expect(folds.length).toBe(4);
		// The exception is documented in place, so the honesty contract is
		// discoverable at the fold site itself.
		expect(body).toContain('#2789');
		expect(body).toContain('canonicalize unknown');
	});
});
