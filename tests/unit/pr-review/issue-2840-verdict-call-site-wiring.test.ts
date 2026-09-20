import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PrReviewTransitionRejectionCode } from '../../../src/pr-review/types.js';

// Issue #2840 wiring ratchet (Phase 4.2 guardrail): the defect class is "a
// durable disclosure is consumed by the inventory but not by an
// authorization decision — the caller forgets the flag". `allowedPrReviewReportVerdicts`
// takes the degradation as an optional third argument, so a future call site
// that omits it would silently restore the pre-#2840 hole. This test pins the
// production call-site set AND requires every production caller to pass
// `disclosedCoverageDegradation`, so an unwired new caller cannot merge.

const REPO_ROOT = path.join(import.meta.dir, '..', '..', '..');

function productionSource(relative: string): string {
	return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf-8');
}

/** Every production call site of allowedPrReviewReportVerdicts( in src/,
 * excluding the definition itself (completion.ts) and comment lines. */
function productionCallSites(): Array<{
	file: string;
	line: number;
	text: string;
}> {
	const sites: Array<{ file: string; line: number; text: string }> = [];
	const srcRoot = path.join(REPO_ROOT, 'src');
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.name.endsWith('.ts')) continue;
			const relative = path.relative(REPO_ROOT, full).replace(/\\/g, '/');
			const lines = productionSource(relative).split('\n');
			for (const [index, line] of lines.entries()) {
				const trimmed = line.trim();
				if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
				// The definition site in completion.ts (export function ...) is
				// not a caller; the re-export in pr-workflow-gate.ts is not a
				// caller either.
				if (
					relative === 'src/pr-review/completion.ts' &&
					trimmed.startsWith('export function allowedPrReviewReportVerdicts')
				) {
					continue;
				}
				if (
					relative === 'src/hooks/pr-workflow-gate.ts' &&
					trimmed.startsWith('allowedPrReviewReportVerdicts,')
				) {
					continue;
				}
				if (trimmed.includes('allowedPrReviewReportVerdicts(')) {
					sites.push({ file: relative, line: index + 1, text: trimmed });
				}
			}
		}
	};
	walk(srcRoot);
	return sites;
}

describe('issue #2840 — allowedPrReviewReportVerdicts call-site wiring ratchet', () => {
	test('the production call-site set is exactly the pinned five sites', () => {
		const sites = productionCallSites().map(
			(site) => `${site.file}:${site.line}`,
		);
		expect(sites).toEqual([
			'src/hooks/pr-workflow-gate.ts:11267', // readPrReviewFinalFindingPolicyForReport
			'src/hooks/pr-workflow-gate.ts:12721', // dispatchCoverageFinalization message formatting
			'src/hooks/pr-workflow-gate.ts:12787', // completion preflight
			'src/hooks/pr-workflow-gate.ts:12814', // completion post-ladder finding-policy check
			'src/pr-review/completion.ts:1660', // readPrReviewTerminalCoverageForReport
		]);
	});

	test('every production call site passes disclosedCoverageDegradation', () => {
		const sites = productionCallSites();
		expect(sites.length).toBeGreaterThan(0);
		// The call spans multiple lines at some sites; read a window around the
		// call line and require the option within it.
		for (const site of sites) {
			const lines = productionSource(site.file).split('\n');
			const window = lines.slice(site.line - 1, site.line + 6).join('\n');
			expect(
				window.includes('disclosedCoverageDegradation'),
				`${site.file}:${site.line} must pass disclosedCoverageDegradation (the #2840 defect class is the unwired caller); call: ${site.text}`,
			).toBe(true);
		}
	});

	test('the reducer rejection-code union carries degraded_disclosure_cannot_approve', () => {
		// Type-level import: if the union is ever narrowed again this file fails
		// to compile. Runtime mirror: the reducer source names the code.
		const code: PrReviewTransitionRejectionCode =
			'degraded_disclosure_cannot_approve';
		const reducerSource = productionSource('src/pr-review/reducer.ts');
		expect(reducerSource).toContain(code);
	});
});
