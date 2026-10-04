/**
 * Epic v2 lifecycle CONTRACT v0 (commit C0 — plan-scoped markers).
 *
 * Two consecutive plans in ONE repository both contain task `1.1`. Through
 * the real completion funnel (`updateTaskStatus` → Rule 2 → real git) and
 * the real Rule 3 evidence read (`resolvePlanMarkerScope` +
 * `readPlanScopedCommittedTaskIds`, which `epic_next_wave` uses):
 *
 *   - plan A's 1.1 commits a marker bound to plan A (`Swarm-Plan:` trailer);
 *   - plan B's Rule 3 does NOT see plan A's marker as evidence for B's 1.1;
 *   - plan B's 1.1 gets its OWN marker commit (no idempotent skip on A's);
 *   - afterwards plan B's Rule 3 sees its own 1.1.
 *
 * Epic runs through the sanctioned path (project config + `/swarm epic
 * start` / `close` lifecycle, forced past sizing for a one-task plan), not a
 * seam: an epic is plan-scoped, so plan B needs its own epic. Later v2 commits extend the lifecycle contract in
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
import { closeEpic } from '../../src/turbo/epic/close.js';
import {
	readPlanScopedCommittedTaskIds,
	resolvePlanMarkerScope,
} from '../../src/turbo/epic/plan-key';
import { startEpic } from '../../src/turbo/epic/start.js';
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
					{
						// Keeps the epic non-empty across plan B's save (savePlan
						// carries 1.1's completed status forward by task id).
						id: '1.2',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: `${title} follow-up`,
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

async function openEpic() {
	return startEpic({
		directory: dir,
		sessionID: 'ses_contractC0',
		force: true,
	});
}

/** The predecessor-evidence read `epic_next_wave` uses (Rule 3). */
async function rule3(taskId: string): Promise<boolean> {
	const current = await loadPlanJsonOnly(dir);
	if (!current) throw new Error('no plan');
	const scope = await resolvePlanMarkerScope(dir, current);
	return readPlanScopedCommittedTaskIds(dir, scope, 10_000).has(taskId);
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
		// `current-branch`: this contract pins marker scoping across two
		// consecutive plans on ONE branch (the epic-branch default would put
		// each plan's markers on its own `swarm/epic/*` branch — C1b).
		JSON.stringify({
			turbo: {
				strategy: 'standard',
				epic: { mode: { enabled: true }, commit_policy: 'current-branch' },
			},
		}),
	);
	// `.swarm/` is runtime state (AGENTS.md #4); keep the tree clean so the
	// scope-less completion may write its marker.
	fs.writeFileSync(path.join(dir, '.gitignore'), '.swarm/\n');
	git(['add', '.']);
	git(['commit', '-q', '-m', 'seed']);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
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
		expect((await openEpic()).status).toBe('started');
		expect(await rule3('1.1')).toBe(false);
		await updateTaskStatus(dir, '1.1', 'completed');
		const afterA = markers();
		expect(afterA).toHaveLength(1);
		expect(afterA[0].subject).toBe('swarm(task 1.1): Contract Plan A task');
		const keyA = afterA[0].trailer;
		expect(keyA).toMatch(/^[0-9a-f]{16}$/);
		expect(await rule3('1.1')).toBe(true);

		expect((await closeEpic({ directory: dir, abandon: true })).status).toBe(
			'closed',
		);

		// Plan B (consecutive, same repo, same task id 1.1).
		await savePlan(dir, plan('Contract Plan B'));
		expect((await openEpic()).status).toBe('started');
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
