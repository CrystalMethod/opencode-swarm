/**
 * Epic v2 lifecycle CONTRACT v2 (commit C2 — `epic_next_wave`).
 *
 * One two-phase epic, end to end, through the production entry points on a
 * real git repository with the default `epic-branch` policy:
 *
 *   `/swarm epic start` → declare_scope → epic_next_wave (dispatch wave 1)
 *   → simulated coder completions (a coder CHILD session attributes an
 *   undeclared write; Rule 2 commits each task's declared files on the
 *   epic branch) → epic_next_wave closes wave 1 (outcomes + divergence from
 *   the child session) and blocks `dirty-baseline` on the undeclared file
 *   → the user commits it → wave 2 → phase-ready-for-review →
 *   epic_phase_review (stub dispatcher) → phase_complete (records the phase
 *   complete on the epic) → phase 2 (its cross-phase dependency satisfied
 *   by the plan-scoped marker) → … → epic-complete → `/swarm epic close`
 *   (squash: the epic diff staged on the original branch; report carries
 *   the waves and outcomes).
 *
 * MINOR 6: no in-wave rework is exercised — C2 still commits at task
 * completion (Rule 2), and rework of a worktree-isolated task keeps the B2
 * deadlock until C3 (commit at landing).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleEpicCommand } from '../../src/commands/epic';
import type { Plan } from '../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../src/db/project-db';
import { savePlan, updateTaskStatus } from '../../src/plan/manager';
import type { ReviewModelDispatcher } from '../../src/review/contracts';
import {
	ensureAgentSession,
	getAgentSession,
	recordModifiedFileForTask,
	recordPhaseAgentDispatch,
	resetSwarmState,
} from '../../src/state';
import { executeDeclareScope } from '../../src/tools/declare-scope';
import { executeEpicPhaseReview } from '../../src/tools/epic-phase-review';
import {
	getOpenEpic,
	isEpicOpenForProject,
} from '../../src/turbo/epic/lifecycle';
import { runEpicNextWave } from '../../src/turbo/epic/next-wave';
import { _internals as startInternals } from '../../src/turbo/epic/start';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';
import { freezeClock, type Restore } from '../helpers/test-clock.js';
import { canonicalMkdtemp } from '../helpers/tmpdir';

const { phase_complete } = await import('../../src/tools/phase-complete');

const SESSION = 'ses_contractV2';
const CODER = 'ses_contractV2_coder';
const FROZEN_ISO = '2026-08-10T12:00:00.000Z';
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const realStart = { ...startInternals };

let dir: string;
let originalCwd: string;
let isolatedEnv: { cleanup: () => void } | undefined;
let restoreClock: Restore | null = null;

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

const PHASES: Array<Array<{ id: string; depends?: string[] }>> = [
	[
		{ id: '1.1' },
		{ id: '1.2' },
		{ id: '1.3', depends: ['1.1'] },
		{ id: '1.4' },
	],
	[{ id: '2.1', depends: ['1.3'] }, { id: '2.2' }, { id: '2.3' }],
];

const fileOf = (id: string) => `src/task-${id}.ts`;
const ident = (id: string) => `task_${id.replace('.', '_')}`;

function plan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Contract V2',
		swarm: 'contract-swarm',
		current_phase: 1,
		migration_status: 'native',
		phases: PHASES.map((tasks, index) => ({
			id: index + 1,
			name: `Phase ${index + 1}`,
			status: 'pending' as const,
			tasks: tasks.map((task) => ({
				id: task.id,
				phase: index + 1,
				status: 'pending' as const,
				size: 'small' as const,
				description: `Create ${fileOf(task.id)} exporting ${ident(task.id)}`,
				depends: task.depends ?? [],
				files_touched: [fileOf(task.id)],
			})),
		})),
	};
}

function writePhaseEvidence(phase: number): void {
	const evidence = path.join(dir, '.swarm', 'evidence');
	fs.mkdirSync(path.join(evidence, `retro-${phase}`), { recursive: true });
	fs.writeFileSync(
		path.join(evidence, `retro-${phase}`, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: `retro-${phase}`,
			entries: [
				{
					task_id: `retro-${phase}`,
					type: 'retrospective',
					timestamp: FROZEN_ISO,
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase retrospective',
					metadata: {},
					phase_number: phase,
					total_tool_calls: 10,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: PHASES[phase - 1].length,
					task_complexity: 'simple',
					top_rejection_reasons: [],
					lessons_learned: [],
				},
			],
			created_at: FROZEN_ISO,
			updated_at: FROZEN_ISO,
		}),
	);
	fs.mkdirSync(path.join(evidence, String(phase)), { recursive: true });
	fs.writeFileSync(
		path.join(evidence, String(phase), 'drift-verifier.json'),
		JSON.stringify({
			entries: [
				{
					type: 'drift-verification',
					verdict: 'approved',
					summary: 'Drift check',
					timestamp: FROZEN_ISO,
				},
			],
		}),
	);
}

const approvingDispatcher: ReviewModelDispatcher = {
	dispatch: async (request) => ({
		status: 'completed',
		agentName: request.agentName,
		text: 'VERDICT: APPROVED\nREASON: the waves integrate cleanly',
		durationMs: 1,
		promptBytes: 0,
		responseBytes: 0,
	}),
};

async function declarePhase(phase: number): Promise<void> {
	for (const task of PHASES[phase - 1]) {
		const declared = await executeDeclareScope(
			{ taskId: task.id, files: [fileOf(task.id)], working_directory: dir },
			dir,
			{ sessionID: SESSION, messageID: `m-${task.id}` },
		);
		expect(declared.success).toBe(true);
	}
	// The wave's coders (simulated) count as this phase's coder dispatches.
	recordPhaseAgentDispatch(SESSION, 'coder');
}

/** What a coder + per-task QA leave behind: the file, then completion (Rule 2). */
async function completeTask(id: string): Promise<void> {
	fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, fileOf(id)),
		`export const ${ident(id)} = '${id}';\n`,
	);
	await updateTaskStatus(dir, id, 'completed');
	expect(git(['log', '-1', '--format=%s'])).toStartWith(`swarm(task ${id}):`);
}

async function reviewAndComplete(phase: number): Promise<void> {
	writePhaseEvidence(phase);
	const review = await executeEpicPhaseReview({ phase }, dir, SESSION, {
		dispatcher: approvingDispatcher,
	});
	expect(review).toMatchObject({ success: true, ready: true });
	const completed = JSON.parse(
		await phase_complete.execute({ phase, sessionID: SESSION }),
	);
	expect(completed.success).toBe(true);
	expect(getOpenEpic(dir)?.phases[String(phase)]).toMatchObject({
		status: 'complete',
		reviewRuns: 1,
		verdicts: ['reviewer:APPROVED critic:APPROVED'],
	});
}

beforeEach(async () => {
	restoreClock = freezeClock({
		isoNow: FROZEN_ISO,
		fixedNow: Date.parse(FROZEN_ISO),
	});
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	startInternals.countTrackedWorktreeDispatches = () => 0;
	dir = canonicalMkdtemp('epic-contract-c2-');
	git(['init', '-q']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'user.name', 'Test User']);
	git(['config', 'commit.gpgsign', 'false']);
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			phase_complete: {
				enabled: true,
				required_agents: ['coder'],
				require_docs: false,
				policy: 'enforce',
			},
			curator: { enabled: false },
			turbo: { strategy: 'standard', epic: { mode: { enabled: true } } },
		}),
	);
	fs.writeFileSync(path.join(dir, '.gitignore'), '.swarm/\n');
	git(['add', '.']);
	git(['commit', '-q', '-m', 'seed']);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	await savePlan(dir, plan());
	ensureAgentSession(SESSION, 'architect', dir);
	ensureAgentSession(CODER, 'coder', dir);
	// phase_complete without a tool context resolves the project from cwd.
	originalCwd = process.cwd();
	process.chdir(dir);
});

afterEach(() => {
	process.chdir(originalCwd);
	restoreClock?.();
	restoreClock = null;
	Object.assign(startInternals, realStart);
	resetSwarmState();
	closeAllProjectDbs();
	isolatedEnv?.cleanup();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('Epic lifecycle contract v2 — start → next_wave … → epic-complete → close', () => {
	test('two phases, waves issued and closed by epic_next_wave, squash-landed at close', async () => {
		const originalBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
		const originalTip = git(['rev-parse', 'HEAD']).trim();
		const started = await handleEpicCommand(dir, ['start'], SESSION);
		expect(started).toContain('opened for plan `contract-swarm-Contract_V2`');
		const epic = getOpenEpic(dir);
		const epicBranch = epic?.git.epicBranch ?? '';
		expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(epicBranch);

		// Phase 1, wave 1.
		await declarePhase(1);
		const wave1 = await runEpicNextWave(dir, SESSION);
		expect(wave1).toMatchObject({
			status: 'dispatch',
			wave: {
				seq: 1,
				phase: 1,
				kind: 'parallel',
				taskIds: ['1.1', '1.2', '1.4'],
			},
		});
		const baseHead = getOpenEpic(dir)?.waves[0]?.baseHead;
		expect(baseHead).toBe(git(['rev-parse', 'HEAD']).trim());
		expect((await runEpicNextWave(dir, SESSION)).status).toBe('in-progress');

		// 1.2's coder (a child session) also writes an undeclared file.
		fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'src', 'extra.ts'), 'export {};\n');
		const coder = getAgentSession(CODER);
		if (!coder) throw new Error('coder session');
		recordModifiedFileForTask(coder, '1.2', fileOf('1.2'), dir);
		recordModifiedFileForTask(coder, '1.2', 'src/extra.ts', dir);
		for (const id of ['1.1', '1.2', '1.4']) await completeTask(id);

		// Wave 1 closes; the stray file is the wave's divergence AND a dirty
		// baseline for the next wave.
		const dirty = await runEpicNextWave(dir, SESSION);
		expect(dirty).toMatchObject({
			status: 'blocked',
			reason: 'dirty-baseline',
			details: { files: ['src/extra.ts'] },
			closedWave: {
				seq: 1,
				divergence: [{ taskId: '1.2', undeclared: ['src/extra.ts'] }],
			},
		});
		let record = getOpenEpic(dir);
		expect(record?.waves[0]).toMatchObject({
			status: 'closed',
			closeHead: git(['rev-parse', 'HEAD']).trim(),
		});
		expect(record?.tasks['1.2']).toMatchObject({
			resolution: 'completed',
			declared: [fileOf('1.2')],
			undeclared: ['src/extra.ts'],
			attribution: 'session',
			marker: { provenance: 'wave-close-head' },
		});
		git(['add', 'src/extra.ts']);
		git(['commit', '-q', '-m', 'user: keep extra.ts']);

		// Wave 2 (1.3 depends on 1.1: plan-scoped marker in git).
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 2, taskIds: ['1.3'] },
		});
		await completeTask('1.3');
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'phase-ready-for-review',
			phase: 1,
			closedWave: { seq: 2 },
		});
		await reviewAndComplete(1);

		// Phase 2 only after phase_complete; 2.1's cross-phase dependency
		// (1.3) is satisfied by its plan-scoped marker.
		await declarePhase(2);
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 3, phase: 2, taskIds: ['2.1', '2.2', '2.3'] },
		});
		for (const id of ['2.1', '2.2', '2.3']) await completeTask(id);
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'phase-ready-for-review',
			phase: 2,
		});
		await reviewAndComplete(2);
		expect((await runEpicNextWave(dir, SESSION)).status).toBe('epic-complete');

		record = getOpenEpic(dir);
		expect(record?.waves.map((w) => [w.seq, w.status])).toEqual([
			[1, 'closed'],
			[2, 'closed'],
			[3, 'closed'],
		]);
		expect(Object.keys(record?.tasks ?? {}).sort()).toEqual([
			'1.1',
			'1.2',
			'1.3',
			'1.4',
			'2.1',
			'2.2',
			'2.3',
		]);
		expect(git(['rev-parse', originalBranch]).trim()).toBe(originalTip);
		const epicDiff = git(['diff', originalTip, epicBranch]);

		// Close (default squash).
		const closed = await handleEpicCommand(dir, ['close'], SESSION);
		expect(closed).toContain('closed (**completed**).');
		expect(closed).toContain('Tasks: 7 completed, 0 closed, 0 pending (of 7).');
		expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
			originalBranch,
		);
		expect(git(['diff', '--cached'])).toBe(epicDiff);
		expect(isEpicOpenForProject(dir)).toBe(false);
		const reports = fs.readdirSync(
			path.join(dir, '.swarm', 'epic-prior', 'reports'),
		);
		const report = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', 'epic-prior', 'reports', reports[0]),
				'utf-8',
			),
		);
		expect(report.waves).toHaveLength(3);
		expect(report.taskOutcomes['1.2'].undeclared).toEqual(['src/extra.ts']);
		expect(report.phases['2'].status).toBe('complete');
	});
});
