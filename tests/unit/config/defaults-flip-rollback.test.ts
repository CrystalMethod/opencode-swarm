/**
 * Defaults-flip rollback tests (issue #2504, governed v8 defaults-flip frame).
 *
 * Pins the per-flip rollback contract: every flipped default has a one-line
 * kill switch that restores the v7 behavior, verified here by execution at a
 * simulated v8 release, plus the doc contract that docs/defaults-governance.md
 * names each kill switch.
 *
 * New file (FR-006): keeps each defaults-flip contract under the 500-line cap.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExecutionProfileSchema } from '../../../src/config/plan-schema';
import {
	AUTO_REVIEW_V8_BURN_IN_DECISION,
	resolveAutoReviewConfig,
} from '../../../src/config/schema';

const INVENTORY_DOC = path.join(
	import.meta.dir,
	'../../../docs/defaults-governance.md',
);

describe('defaults-flip rollback kill switches (#2504)', () => {
	const v8Context = {
		packageVersion: '8.0.0',
		burnInDecision: AUTO_REVIEW_V8_BURN_IN_DECISION,
	};

	test('auto_review kill switch: explicit enabled:false stays false at v8', () => {
		const config = resolveAutoReviewConfig({ enabled: false }, v8Context);
		expect(config.enabled).toBe(false);
	});

	test('conservative preset restores the v7 auto_review posture at v8', () => {
		const config = resolveAutoReviewConfig(
			{},
			{ ...v8Context, preset: 'conservative' },
		);
		expect(config.enabled).toBe(false);
	});

	test('conservative preset + explicit re-enable wins over the preset', () => {
		const config = resolveAutoReviewConfig(
			{ enabled: true },
			{ ...v8Context, preset: 'conservative' },
		);
		expect(config.enabled).toBe(true);
	});

	test('per-plan parallelization kill switch: explicit false survives the schema', () => {
		const profile = ExecutionProfileSchema.parse({
			parallelization_enabled: false,
		});
		expect(profile.parallelization_enabled).toBe(false);
	});

	test('inventory doc names both kill switches (doc contract)', () => {
		const doc = fs.readFileSync(INVENTORY_DOC, 'utf-8');
		expect(doc).toContain('kill switch');
		expect(doc).toContain('auto_review.enabled');
		expect(doc).toContain('execution_profile.parallelization_enabled');
		expect(doc).toContain('rollback');
	});
});
