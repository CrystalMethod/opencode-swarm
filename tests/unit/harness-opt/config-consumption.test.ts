import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { handleHarnessOptRun } from '../../../src/commands/harness-opt.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Defect class "config declared but not consumed" (plan Phase 4.2): the
 * `harness_opt` block must actually gate the run handler. A disabled config
 * short-circuits BEFORE any controller work (no durable state is created);
 * an enabled config gets past the gate to the next typed refusal.
 */
let root = '';

beforeEach(() => {
	root = canonicalMkdtemp('harnessopt-config-');
	writeFileSync(path.join(root, 'README.md'), 'fixture\n');
	for (const args of [
		['init'],
		[
			'-c',
			'user.name=Test',
			'-c',
			'user.email=test@example.invalid',
			'commit',
			'--allow-empty',
			'-m',
			'fixture',
		],
	]) {
		execFileSync('git', args, { cwd: root, timeout: 30_000, stdio: 'ignore' });
	}
});

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

const enabledConfig = {
	enabled: true,
	max_rounds: 5,
	max_transient_retries: 2,
	max_wall_clock_ms: 3_600_000,
	run_ablation_arm: true,
	run_simple_agent_arm: true,
};

const disabledConfig = { ...enabledConfig, enabled: false };

describe('harness_opt config consumption', () => {
	test('enabled=false short-circuits the run handler before any controller work', async () => {
		const output = await handleHarnessOptRun(root, ['--confirm'], {
			config: disabledConfig,
		});
		expect(output).toMatch(/disabled/);
		expect(
			existsSync(path.join(root, '.swarm', 'evolution', 'harness-opt')),
			'disabled run must not create durable harness-opt state',
		).toBe(false);
	});

	test('enabled=true passes the gate and reaches the tasks-file validation', async () => {
		const output = await handleHarnessOptRun(root, ['--confirm'], {
			config: enabledConfig,
		});
		expect(output).not.toMatch(/disabled/);
		expect(output).toMatch(/--tasks/);
	});

	test('an invalid harness_opt block resolves to the safe default (disabled)', async () => {
		const output = await handleHarnessOptRun(root, ['--confirm'], {
			config: { 'not-a-field': true } as unknown as typeof enabledConfig,
		});
		expect(output).toMatch(/disabled/);
	});
});
