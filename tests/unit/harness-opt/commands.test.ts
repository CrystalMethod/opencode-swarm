import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	handleHarnessOptCompare,
	handleHarnessOptPlan,
	handleHarnessOptRun,
	handleHarnessOptStatus,
} from '../../../src/commands/harness-opt.js';
import { COMMAND_REGISTRY } from '../../../src/commands/registry.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let root = '';

beforeEach(() => {
	root = canonicalMkdtemp('harnessopt-commands-');
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

describe('harness-opt command registration', () => {
	test('registers the family with human-only run/stop and agent read-only surfaces', () => {
		const family = [
			'harness-opt',
			'harness-opt plan',
			'harness-opt run',
			'harness-opt status',
			'harness-opt stop',
			'harness-opt history',
		];
		for (const key of family) {
			expect(
				COMMAND_REGISTRY[key as keyof typeof COMMAND_REGISTRY],
			).toBeDefined();
		}
		expect(
			(
				COMMAND_REGISTRY['harness-opt run'] as {
					toolPolicy?: string;
				}
			).toolPolicy,
		).toBe('human-only');
		expect(
			(COMMAND_REGISTRY['harness-opt stop'] as { toolPolicy?: string })
				.toolPolicy,
		).toBe('human-only');
		expect(
			(COMMAND_REGISTRY['harness-opt status'] as { toolPolicy?: string })
				.toolPolicy,
		).toBe('agent');
	});
});

describe('harness-opt run gating', () => {
	test('refuses without --confirm even before any config check', async () => {
		const output = await handleHarnessOptRun(root, []);
		expect(output).toMatch(/confirm/i);
		const parsed = JSON.parse(output.replace(/```json\n|\n```/g, '')) as {
			status: string;
		};
		expect(parsed.status).toBe('needs-confirm');
	});

	test('refuses when disabled even with --confirm', async () => {
		const output = await handleHarnessOptRun(root, ['--confirm'], {
			config: {
				enabled: false,
				max_rounds: 5,
				max_transient_retries: 2,
				max_wall_clock_ms: 3_600_000,
				run_ablation_arm: true,
				run_simple_agent_arm: true,
			},
		});
		expect(output).toMatch(/disabled/);
	});

	test('refuses a run without a tasks file', async () => {
		const output = await handleHarnessOptRun(root, ['--confirm'], {
			config: {
				enabled: true,
				max_rounds: 5,
				max_transient_retries: 2,
				max_wall_clock_ms: 3_600_000,
				run_ablation_arm: true,
				run_simple_agent_arm: true,
			},
		});
		expect(output).toMatch(/--tasks/);
	});

	test('refuses when no evaluation dispatcher is available', async () => {
		writeFileSync(
			path.join(root, 'tasks.json'),
			JSON.stringify([
				{ id: 'cmd-task', instruction: 'reply with {"v":1,"caught":true}' },
			]),
		);
		const output = await handleHarnessOptRun(
			root,
			['--confirm', '--tasks', 'tasks.json'],
			{
				config: {
					enabled: true,
					max_rounds: 5,
					max_transient_retries: 2,
					max_wall_clock_ms: 3_600_000,
					run_ablation_arm: true,
					run_simple_agent_arm: true,
				},
			},
		);
		expect(output).toMatch(/dispatcher/);
	});

	test('rejects a tasks path that escapes the project root', async () => {
		const output = await handleHarnessOptPlan(root, [
			'--tasks',
			'../outside.json',
		]);
		expect(output).toMatch(/inside the project root/);
	});

	test('rejects a malformed tasks file', async () => {
		writeFileSync(path.join(root, 'tasks.json'), JSON.stringify([{ id: 'x' }]));
		const output = await handleHarnessOptPlan(root, ['--tasks', 'tasks.json']);
		expect(output).toMatch(/\{id, instruction\}/);
	});
});

describe('harness-opt compare gating (separately executable comparative package)', () => {
	test('refuses without --confirm', async () => {
		const output = await handleHarnessOptCompare(root, []);
		expect(output).toMatch(/confirm/i);
	});

	test('honors run_ablation_arm=false from the project config through the registered path', async () => {
		writeFileSync(
			path.join(root, 'tasks.json'),
			JSON.stringify([
				{
					id: 'toggle-cmd-task',
					instruction: 'reply with {"v":1,"caught":true}',
				},
			]),
		);
		writeFileSync(
			path.join(root, 'opencode.json'),
			JSON.stringify({ harness_opt: { run_ablation_arm: false } }),
		);
		// A minimal evaluation dispatcher: every invocation completes with
		// the scorer payload. The handler's reported arms object then proves
		// which arms actually ran under the project-config toggle.
		const dispatcher = (async () => ({
			status: 'completed' as const,
			text: '{"v":1,"caught":true}',
			durationMs: 1,
			cost: { source: 'reported' as const, usd: 0 },
		})) as unknown as NonNullable<
			Parameters<typeof handleHarnessOptCompare>[2]
		>['dispatcher'];
		const output = await handleHarnessOptCompare(
			root,
			['--confirm', '--tasks', 'tasks.json', '--json'],
			{ dispatcher },
		);
		const parsed = JSON.parse(output) as {
			arms: Record<string, unknown>;
		};
		expect(Object.keys(parsed.arms)).toEqual(['baseline', 'simple-agent']);
	});

	test('refuses an invalid comparative manifest before any execution', async () => {
		writeFileSync(
			path.join(root, 'tasks.json'),
			JSON.stringify([
				{ id: 'cmp-task', instruction: 'reply with {"v":1,"caught":true}' },
			]),
		);
		writeFileSync(
			path.join(root, 'manifest.json'),
			JSON.stringify({ releaseName: '' }),
		);
		const output = await handleHarnessOptCompare(root, [
			'--confirm',
			'--tasks',
			'tasks.json',
			'--manifest',
			'manifest.json',
		]);
		expect(output).toMatch(/MANIFEST_FIELD_EMPTY/);
	});
});

describe('harness-opt plan/status wiring', () => {
	test('plan freezes the task set (dry-run, no round executed)', async () => {
		writeFileSync(
			path.join(root, 'tasks.json'),
			JSON.stringify([
				{ id: 'cmd-task', instruction: 'reply with {"v":1,"caught":true}' },
			]),
		);
		const output = await handleHarnessOptPlan(root, [
			'--tasks',
			'tasks.json',
			'--json',
		]);
		const parsed = JSON.parse(output) as {
			status: string;
			frozen: { ok: boolean };
		};
		expect(parsed.status).toBe('ok');
		expect(parsed.frozen.ok).toBe(true);
	});

	test('status reports loop state', async () => {
		const output = await handleHarnessOptStatus(root, ['--json']);
		const parsed = JSON.parse(output) as {
			status: string;
			loop: { roundCounter: number };
		};
		expect(parsed.status).toBe('ok');
		expect(parsed.loop.roundCounter).toBe(0);
	});
});
