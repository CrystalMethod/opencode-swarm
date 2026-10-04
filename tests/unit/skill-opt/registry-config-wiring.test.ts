import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { executeSwarmCommand } from '../../../src/commands/command-dispatch.js';
import { loadPluginConfig } from '../../../src/config/loader.js';
import type { PluginConfig } from '../../../src/config/schema.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Registry config wiring for the skill_opt family (issue #2949): the
 * `skill_opt` block set ONLY in `.opencode/opencode-swarm.json` — the
 * documented surface — must reach the registered `run` handler (and both
 * registry entries routing to plan), and the undocumented root
 * `opencode.json` must gate nothing.
 */
let root = '';
let cleanupEnv: { cleanup: () => void } | undefined;

function writeSwarmConfig(skillOpt: unknown): void {
	mkdirSync(path.join(root, '.opencode'), { recursive: true });
	writeFileSync(
		path.join(root, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ skill_opt: skillOpt }),
	);
}

function dispatch(tokens: string[], config: PluginConfig): Promise<string> {
	return executeSwarmCommand({
		directory: root,
		agents: {},
		sessionID: 'skill-opt-registry-wiring-test',
		tokens,
		config,
	}).then((r) => r.text);
}

beforeEach(() => {
	cleanupEnv = createIsolatedTestEnv();
	root = canonicalMkdtemp('skillopt-registry-');
	writeFileSync(path.join(root, 'README.md'), 'fixture\n');
});

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	cleanupEnv?.cleanup();
	cleanupEnv = undefined;
});

describe('skill_opt registry config wiring (issue #2949)', () => {
	test('registered run observes skill_opt.enabled=true set only in opencode-swarm.json', async () => {
		writeSwarmConfig({ enabled: true });
		const cfg = loadPluginConfig(root);
		expect(cfg.skill_opt?.enabled).toBe(true);
		// Dispatch WITHOUT --confirm on purpose: the enabled gate runs before
		// the confirm check, so a correctly wired dispatch lands on the
		// deterministic needs-confirm refusal and never the eval loop.
		const output = await dispatch(['skill-opt', 'run', 'wiring-slug'], cfg);
		expect(output).not.toMatch(/"status":\s*"disabled"/);
		expect(output).toMatch(/pass --confirm/);
	});

	test('opencode.json no longer gates anything: only-file project is refused with a message naming opencode-swarm.json', async () => {
		writeFileSync(
			path.join(root, 'opencode.json'),
			JSON.stringify({ skill_opt: { enabled: true } }),
		);
		const cfg = loadPluginConfig(root);
		expect(cfg.skill_opt?.enabled).toBeUndefined();
		const output = await dispatch(['skill-opt', 'run', 'wiring-slug'], cfg);
		expect(output).toMatch(/"status":\s*"disabled"/);
		expect(output).toMatch(/opencode-swarm\.json/);
	});

	test('a present-but-false block keeps the enabled-is-false wording', async () => {
		writeSwarmConfig({ enabled: false });
		const cfg = loadPluginConfig(root);
		const output = await dispatch(['skill-opt', 'run', 'wiring-slug'], cfg);
		expect(output).toMatch(/"status":\s*"disabled"/);
		expect(output).toMatch(/skill_opt\.enabled is false/);
		expect(output).not.toMatch(/block not found/);
	});

	test('both plan registry closures pass config (anchored source ratchet)', () => {
		const src = readFileSync(
			path.resolve(import.meta.dir, '../../../src/commands/registry.ts'),
			'utf8',
		);
		for (const key of ['skill-opt', 'skill-opt plan']) {
			const anchor = `\n\t'${key}': {`;
			const start = src.indexOf(anchor);
			expect(start, `${key} entry must exist`).toBeGreaterThanOrEqual(0);
			const next = src.indexOf("\n\t'", start + anchor.length);
			const block = src.slice(start, next === -1 ? undefined : next);
			const h = block.indexOf('handler:');
			const d = block.indexOf('description:');
			const region = block.slice(h, d === -1 ? undefined : d);
			expect(
				/config:\s*ctx\.config\?\.skill_opt/.test(region),
				`${key} closure must pass ctx.config?.skill_opt into the handler runtime`,
			).toBe(true);
		}
	});
});
