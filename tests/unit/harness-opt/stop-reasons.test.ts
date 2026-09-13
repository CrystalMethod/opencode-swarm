import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	HARNESS_OPT_STOP_REASONS,
	type HarnessOptStopReason,
} from '../../../src/services/harness-optimizer/controller.js';

/**
 * Stop-reason producer discipline (issue #2503, final-critic revision): every
 * enum member must be PRODUCED by a real controller/command code path — the
 * exported HARNESS_OPT_STOP_REASONS constant is the produced list, the type
 * is derived from it (so declaring an unproduced member is a compile error),
 * and the production sites are grepped from the live source, not from a
 * local copy of the list (no string-literal test theater). The frozen
 * acceptance check C5 matches /transient|budget|circuit/i against the
 * reported stop reason, so an `inconclusive` outcome must never satisfy it.
 */
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const CONTROLLER_SOURCE = readFileSync(
	path.join(REPO_ROOT, 'src', 'services', 'harness-optimizer', 'controller.ts'),
	'utf8',
);
const COMMAND_SOURCE = readFileSync(
	path.join(REPO_ROOT, 'src', 'commands', 'harness-opt.ts'),
	'utf8',
);

const C5_REGEX = /transient|budget|circuit/i;

/** Members produced as string literals by production code (not the const). */
const PRODUCTION_SITES: Record<HarnessOptStopReason, string> = {
	completed: CONTROLLER_SOURCE,
	inconclusive: CONTROLLER_SOURCE,
	transient_retry_budget_exhausted: CONTROLLER_SOURCE,
	round_budget_exhausted: COMMAND_SOURCE,
	wall_clock_budget_exhausted: CONTROLLER_SOURCE,
	spend_budget_exhausted: CONTROLLER_SOURCE,
	stopped_by_operator: CONTROLLER_SOURCE,
};

describe('harness-opt stop-reason producer discipline', () => {
	test('the type is derived from the produced constant (no phantom members)', () => {
		expect(HARNESS_OPT_STOP_REASONS).toHaveLength(7);
		for (const reason of HARNESS_OPT_STOP_REASONS) {
			expect(typeof reason).toBe('string');
		}
	});

	test('every enum member has a production site in live source (not test literals)', () => {
		for (const [reason, source] of Object.entries(PRODUCTION_SITES)) {
			// The producing site must quote the reason as a RETURNED value,
			// not merely declare it in the exported constant block.
			expect(
				mentionsOutsideConstantBlock(source, reason),
				`${reason} must be produced outside the HARNESS_OPT_STOP_REASONS declaration`,
			).toBe(true);
		}
	});

	test('the four exhaustion reasons satisfy the budget/circuit regex', () => {
		for (const reason of [
			'transient_retry_budget_exhausted',
			'round_budget_exhausted',
			'wall_clock_budget_exhausted',
			'spend_budget_exhausted',
		] as const) {
			expect(C5_REGEX.test(reason), `${reason} should match`).toBe(true);
		}
	});

	test('no other produced reason satisfies the regex (inconclusive cannot masquerade)', () => {
		for (const reason of [
			'completed',
			'inconclusive',
			'stopped_by_operator',
		] as const) {
			expect(C5_REGEX.test(reason), `${reason} should NOT match`).toBe(false);
		}
	});
});

function mentionsOutsideConstantBlock(source: string, reason: string): boolean {
	const constStart = source.indexOf('HARNESS_OPT_STOP_REASONS');
	if (constStart < 0) return source.includes(`'${reason}'`);
	const blockEnd = source.indexOf('] as const;', constStart);
	const outside = `${source.slice(0, constStart)}${source.slice(blockEnd >= 0 ? blockEnd + '] as const;'.length : constStart)}`;
	return outside.includes(`'${reason}'`);
}
