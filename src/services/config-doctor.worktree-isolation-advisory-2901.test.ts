import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createIsolatedTestEnv } from '../../tests/helpers/isolated-test-env';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir';
import { PlanSchema } from '../config/plan-schema';
import type { PluginConfig } from '../config/schema';
import {
	_internals as doctorInternals,
	resolvePlanParallelizationFlag,
	runConfigDoctor,
	runConfigDoctorWithFixes,
} from '../services/config-doctor';

/**
 * Issue #2901 — the `worktree-isolation-baseline-active` advisory is keyed on
 * the settings that actually drive parallel dispatch: the plan execution
 * profile's `parallelization_enabled` plus the top-level `worktree.policy`.
 * The dark `parallelization` config block no longer triggers it on its own.
 *
 * Split from src/services/config-doctor.test.ts (over-cap under FR-006); the
 * two re-keyed #1552 policy-required / policy-disabled cases stay there.
 */

let cleanupEnv: (() => void) | undefined;
let tempDir: string;

function createTestConfigObj(
	overrides: Record<string, unknown> = {},
): PluginConfig {
	return {
		max_iterations: 5,
		config_format_version: 3,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		...overrides,
	} as PluginConfig;
}

beforeEach(() => {
	cleanupEnv = createIsolatedTestEnv().cleanup;
	tempDir = canonicalMkdtemp('worktree-advisory-2901-');
});

afterEach(() => {
	cleanupEnv?.();
	cleanupEnv = undefined;
});

describe('worktree-isolation advisory re-key (issue #2901)', () => {
	it('dark parallelization config alone no longer triggers the advisory', () => {
		const config = createTestConfigObj({
			parallelization: {
				enabled: true,
				maxConcurrentTasks: 2,
				evidenceLockTimeoutMs: 60000,
				max_coders: 3,
				max_reviewers: 2,
			},
		});

		// No plan flag supplied (no plan available): the dark block must not
		// produce the "already active" assurance on its own.
		const result = runConfigDoctor(config, tempDir);

		expect(
			result.findings.some(
				(f) => f.id === 'worktree-isolation-baseline-active',
			),
		).toBe(false);
	});

	it('plan execution profile plus default worktree policy triggers the advisory', () => {
		const config = createTestConfigObj({
			worktree: {
				policy: 'auto',
				merge_strategy: 'merge',
				deps_strategy: 'skip',
			},
		});

		const result = runConfigDoctor(config, tempDir, true);

		expect(
			result.findings.some(
				(f) => f.id === 'worktree-isolation-baseline-active',
			),
		).toBe(true);
	});

	it('plan execution profile with parallelization disabled does not trigger the advisory', () => {
		const config = createTestConfigObj({
			worktree: {
				policy: 'auto',
				merge_strategy: 'merge',
				deps_strategy: 'skip',
			},
		});

		const result = runConfigDoctor(config, tempDir, false);

		expect(
			result.findings.some(
				(f) => f.id === 'worktree-isolation-baseline-active',
			),
		).toBe(false);
	});

	it('resolvePlanParallelizationFlag returns null without a plan and feeds the async entry', async () => {
		const config = createTestConfigObj({
			parallelization: {
				enabled: true,
				maxConcurrentTasks: 2,
				evidenceLockTimeoutMs: 60000,
				max_coders: 3,
				max_reviewers: 2,
			},
		});

		// tempDir has no .swarm/plan.json, so the flag resolves to null and
		// the dark-key config must not trigger the advisory through the
		// async entry either.
		expect(await resolvePlanParallelizationFlag(tempDir)).toBeNull();

		const { result } = await runConfigDoctorWithFixes(tempDir, config, false);
		expect(
			result.findings.some(
				(f) => f.id === 'worktree-isolation-baseline-active',
			),
		).toBe(false);
	});
});

describe('resolvePlanParallelizationFlag through real plan fixtures (issue #2901)', () => {
	function writePlan(
		dir: string,
		parallelizationEnabled: boolean | null,
		corrupt = false,
	): void {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		if (corrupt) {
			fs.writeFileSync(
				path.join(dir, '.swarm', 'plan.json'),
				'{"schema_version": "9.9.9", "bogus": true}',
			);
			return;
		}
		const plan = PlanSchema.parse({
			schema_version: '1.0.0',
			title: '2901 advisory helper plan',
			swarm: 'local',
			phases: [{ id: 1, name: 'phase-1', tasks: [] }],
			execution_profile: { parallelization_enabled: parallelizationEnabled },
		});
		fs.writeFileSync(
			path.join(dir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
	}

	it('returns true for a plan with execution_profile.parallelization_enabled=true', async () => {
		writePlan(tempDir, true);
		expect(await resolvePlanParallelizationFlag(tempDir)).toBe(true);
	});

	it('returns false for a plan with execution_profile.parallelization_enabled=false', async () => {
		writePlan(tempDir, false);
		expect(await resolvePlanParallelizationFlag(tempDir)).toBe(false);
	});

	it('returns null for a plan that fails PlanSchema validation', async () => {
		writePlan(tempDir, true, true);
		expect(await resolvePlanParallelizationFlag(tempDir)).toBeNull();
	});

	it('returns null (advisory suppressed) when the loadPlanJsonOnly seam throws', async () => {
		const realLoadPlanJsonOnly = doctorInternals.loadPlanJsonOnly;
		doctorInternals.loadPlanJsonOnly = () => {
			throw new Error('synthetic plan-read failure');
		};
		try {
			expect(await resolvePlanParallelizationFlag(tempDir)).toBeNull();
		} finally {
			doctorInternals.loadPlanJsonOnly = realLoadPlanJsonOnly;
		}
	});

	it('worktree policy disabled suppresses the advisory even with no plan (explicit combo)', () => {
		const config = createTestConfigObj({
			worktree: {
				policy: 'disabled',
				merge_strategy: 'merge',
				deps_strategy: 'skip',
			},
		});

		// No 3rd arg: flag resolves to null. The AND-guard makes the advisory
		// unreachable here; pinned explicitly so the matrix stays covered.
		const result = runConfigDoctor(config, tempDir);

		expect(
			result.findings.some(
				(f) => f.id === 'worktree-isolation-baseline-active',
			),
		).toBe(false);
	});
});
