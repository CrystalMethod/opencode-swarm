/**
 * Epic v2 lifecycle CONTRACT v0 (commit C0 — plan-scoped markers).
 *
 * Two consecutive plans in ONE repository both contain task `1.1`. Through
 * the real completion funnel (`updateTaskStatus` → Rule 2 → real git) and
 * the real Rule 3 evidence read (`buildIsUpstreamCommittedWithStatus`):
 *
 *   - plan A's 1.1 commits a marker bound to plan A (`Swarm-Plan:` trailer);
 *   - plan B's Rule 3 does NOT see plan A's marker as evidence for B's 1.1;
 *   - plan B's 1.1 gets its OWN marker commit (no idempotent skip on A's);
 *   - afterwards plan B's Rule 3 sees its own 1.1.
 *
 * Epic is enabled through the sanctioned path (project config + session
 * state), not a seam. Later v2 commits extend the lifecycle contract in
 * sibling `epic-lifecycle-contract*.test.ts` files.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../src/config/plan-schema';
import { closeProjectDb } from '../../src/db/project-db.js';
import {
	loadPlanJsonOnly,
	savePlan,
	updateTaskStatus,
} from '../../src/plan/manager';
import { enableEpicMode } from '../../src/turbo/epic/state.js';
import { buildIsUpstreamCommittedWithStatus } from '../../src/turbo/epic/upstream-commits';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../helpers/tmpdir';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
let dir: string;
let isolatedEnv: { cleanup: () => void } | undefined;

function git(args: string[]): string {
	const r = spawnSync('git', args, {
		cwd: dir,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
		env: { ...process.env, GIT_CONFIG_GLOBAL: NULL_DEVICE },
	});
	if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
	return r.stdout;
}

function plan(title: string): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'contract-swarm',
		current_phase: 1,
		migration_status: 'native',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'in_progress',
						size: 'small',
						description: `${title} task`,
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

function markers(): Array<{ subject: string; trailer: string | null }> {
	return git(['log', '--format=%x1e%B'])
		.split('\x1e')
		.filter((r) => r.startsWith('swarm(task '))
		.map((r) => {
			const trailer = /^Swarm-Plan: (\S+)$/m.exec(r);
			return { subject: r.split('\n')[0], trailer: trailer?.[1] ?? null };
		});
}

async function rule3(taskId: string): Promise<boolean> {
	const evidence = await buildIsUpstreamCommittedWithStatus(
		dir,
		await loadPlanJsonOnly(dir),
	);
	expect(evidence.gitFailed).toBe(false);
	return evidence.predicate(taskId);
}

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	dir = canonicalMkdtemp('epic-contract-c0-');
	git(['init', '-q']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'user.name', 'Test User']);
	git(['config', 'commit.gpgsign', 'false']);
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			turbo: { strategy: 'standard', epic: { mode: { enabled: true } } },
		}),
	);
	// `.swarm/` is runtime state (AGENTS.md #4); keep the tree clean so the
	// scope-less completion may write its marker.
	fs.writeFileSync(path.join(dir, '.gitignore'), '.swarm/\n');
	git(['add', '.']);
	git(['commit', '-q', '-m', 'seed']);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	enableEpicMode(dir, 'contract-c0-session');
});

afterEach(() => {
	try {
		closeProjectDb(dir);
	} catch {
		// best-effort
	}
	isolatedEnv?.cleanup();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('Epic lifecycle contract v0 — plan-scoped markers across consecutive plans', () => {
	test("plan B's 1.1 gets its own commit and B's Rule 3 never sees plan A's marker", async () => {
		// Plan A: 1.1 completes → Rule 2 marker bound to plan A.
		await savePlan(dir, plan('Contract Plan A'));
		expect(await rule3('1.1')).toBe(false);
		await updateTaskStatus(dir, '1.1', 'completed');
		const afterA = markers();
		expect(afterA).toHaveLength(1);
		expect(afterA[0].subject).toBe('swarm(task 1.1): Contract Plan A task');
		const keyA = afterA[0].trailer;
		expect(keyA).toMatch(/^[0-9a-f]{16}$/);
		expect(await rule3('1.1')).toBe(true);

		// Plan B (consecutive, same repo, same task id 1.1).
		await savePlan(dir, plan('Contract Plan B'));
		expect(await rule3('1.1')).toBe(false);

		await updateTaskStatus(dir, '1.1', 'completed');
		const afterB = markers();
		expect(afterB).toHaveLength(2);
		expect(afterB[0].subject).toBe('swarm(task 1.1): Contract Plan B task');
		const keyB = afterB[0].trailer;
		expect(keyB).toMatch(/^[0-9a-f]{16}$/);
		expect(keyB).not.toBe(keyA);
		expect(await rule3('1.1')).toBe(true);
	});
});
