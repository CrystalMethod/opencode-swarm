import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { executeSwarmCommand } from '../../../src/commands/command-dispatch.js';
import { handleHarnessOptRun } from '../../../src/commands/harness-opt.js';
import { loadPluginConfig } from '../../../src/config/loader.js';
import type { PluginConfig } from '../../../src/config/schema.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Registry config wiring for the harness_opt family (issue #2949): the
 * `harness_opt` block set ONLY in `.opencode/opencode-swarm.json` — the
 * documented surface — must reach the registered `run`/`compare` handlers
 * through real `executeSwarmCommand` dispatch, and the undocumented root
 * `opencode.json` must gate nothing.
 */
let root = '';
let cleanupEnv: { cleanup: () => void } | undefined;

function initScratch(): string {
	const dir = canonicalMkdtemp('harnessopt-registry-');
	writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
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
		execFileSync('git', args, {
			cwd: dir,
			timeout: 30_000,
			stdio: 'ignore',
		});
	}
	return dir;
}

function writeSwarmConfig(dir: string, harnessOpt: unknown): void {
	mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ harness_opt: harnessOpt }),
	);
}

function dispatch(
	dir: string,
	tokens: string[],
	config: PluginConfig,
	extra: { evaluationModelDispatcher?: unknown } = {},
): Promise<string> {
	return executeSwarmCommand({
		directory: dir,
		agents: {},
		sessionID: 'registry-config-wiring-test',
		tokens,
		config,
		evaluationModelDispatcher: extra.evaluationModelDispatcher as never,
	}).then((r) => r.text);
}

beforeEach(() => {
	cleanupEnv = createIsolatedTestEnv();
	root = initScratch();
});

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	cleanupEnv?.cleanup();
	cleanupEnv = undefined;
});

describe('harness_opt registry config wiring (issue #2949)', () => {
	test('registered run observes harness_opt.enabled=true set only in opencode-swarm.json', async () => {
		writeSwarmConfig(root, { enabled: true });
		const cfg = loadPluginConfig(root);
		expect(cfg.harness_opt?.enabled).toBe(true);
		const output = await dispatch(
			root,
			['harness-opt', 'run', '--confirm'],
			cfg,
		);
		expect(output).not.toMatch(/"status":\s*"disabled"/);
		expect(output).toMatch(/--tasks/);
	});

	test('registered compare observes run_ablation_arm=false from opencode-swarm.json', async () => {
		writeSwarmConfig(root, { run_ablation_arm: false });
		writeFileSync(
			path.join(root, 'tasks.json'),
			JSON.stringify([
				{ id: 'wiring-task', instruction: 'reply with {"v":1,"caught":true}' },
			]),
		);
		const cfg = loadPluginConfig(root);
		// Minimal evaluation dispatcher: every invocation completes with the
		// scorer payload (the commands.test.ts stub pattern) so the reported
		// arms object proves which arms ran under the config's arm toggles.
		const dispatcher = (async () => ({
			status: 'completed' as const,
			text: '{"v":1,"caught":true}',
			durationMs: 1,
			cost: { source: 'reported' as const, usd: 0 },
		})) as never;
		const output = await dispatch(
			root,
			[
				'harness-opt',
				'compare',
				'--confirm',
				'--tasks',
				'tasks.json',
				'--json',
			],
			cfg,
			{ evaluationModelDispatcher: dispatcher },
		);
		const parsed = JSON.parse(output) as { arms: Record<string, unknown> };
		expect(Object.keys(parsed.arms)).toEqual(['baseline', 'simple-agent']);
	});

	test('the registry closures pass config (anchored source ratchet)', () => {
		const src = readFileSync(
			path.resolve(import.meta.dir, '../../../src/commands/registry.ts'),
			'utf8',
		);
		for (const key of ['harness-opt run', 'harness-opt compare']) {
			const anchor = `\n\t'${key}': {`;
			const start = src.indexOf(anchor);
			expect(start, `${key} entry must exist`).toBeGreaterThanOrEqual(0);
			const next = src.indexOf("\n\t'", start + anchor.length);
			const block = src.slice(start, next === -1 ? undefined : next);
			const h = block.indexOf('handler:');
			const d = block.indexOf('description:');
			const region = block.slice(h, d === -1 ? undefined : d);
			expect(
				/config:\s*ctx\.config\?\.harness_opt/.test(region),
				`${key} closure must pass ctx.config?.harness_opt into the handler runtime`,
			).toBe(true);
		}
	});

	test('opencode.json no longer gates anything: only-file project is refused with a message naming opencode-swarm.json', async () => {
		writeFileSync(
			path.join(root, 'opencode.json'),
			JSON.stringify({ harness_opt: { enabled: true } }),
		);
		const cfg = loadPluginConfig(root);
		expect(cfg.harness_opt?.enabled).toBeUndefined();
		const output = await dispatch(
			root,
			['harness-opt', 'run', '--confirm'],
			cfg,
		);
		expect(output).toMatch(/"status":\s*"disabled"/);
		expect(output).toMatch(/opencode-swarm\.json/);
	});

	test('a present-but-false block keeps the enabled-is-false wording', async () => {
		writeSwarmConfig(root, { enabled: false });
		const cfg = loadPluginConfig(root);
		const output = await dispatch(
			root,
			['harness-opt', 'run', '--confirm'],
			cfg,
		);
		expect(output).toMatch(/"status":\s*"disabled"/);
		expect(output).toMatch(/harness_opt\.enabled is false/);
		expect(output).not.toMatch(/block not found/);
	});

	test('a malformed block is per-field sanitized: present-but-false wording, never "block not found"', async () => {
		// The loader sanitizes per field (recovery "sanitized_values", the bad
		// key lands in removedKeys) and keeps the block present with the
		// sanitized default, so a user who DID write a block gets the accurate
		// enabled-is-false message; /swarm config doctor names the removed key.
		writeSwarmConfig(root, { enabled: 'banana' });
		const cfg = loadPluginConfig(root);
		expect(cfg.harness_opt).toBeDefined();
		expect(cfg.harness_opt?.enabled).toBe(false);
		const output = await dispatch(
			root,
			['harness-opt', 'run', '--confirm'],
			cfg,
		);
		expect(output).toMatch(/"status":\s*"disabled"/);
		expect(output).toMatch(/harness_opt\.enabled is false/);
		expect(output).not.toMatch(/block not found/);
	});

	test('direct injection keeps working unchanged (config-consumption contract)', async () => {
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
		expect(output).not.toMatch(/disabled/);
		expect(output).toMatch(/--tasks/);
	});

	test('injected config wins over the on-disk block (wiring-discriminating arm)', async () => {
		// Disk says disabled; the dispatch injects enabled:true. With the
		// closure wiring intact the handler sees the injected block and passes
		// the gate; if the wiring were removed the fallback would re-read the
		// on-disk enabled:false block and refuse.
		writeSwarmConfig(root, { enabled: false });
		const cfg = loadPluginConfig(root);
		expect(cfg.harness_opt?.enabled).toBe(false);
		const injected = {
			...cfg,
			harness_opt: { ...cfg.harness_opt, enabled: true },
		};
		const output = await dispatch(
			root,
			['harness-opt', 'run', '--confirm'],
			injected,
		);
		expect(output).not.toMatch(/"status":\s*"disabled"/);
		expect(output).toMatch(/--tasks/);
	});
});
