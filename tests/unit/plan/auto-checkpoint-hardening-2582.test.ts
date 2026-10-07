/**
 * Issue #2582/#2864 — review-hardening tests for the
 * `checkpoint.auto_checkpoint_threshold` runtime consumer
 * (`src/plan/auto-checkpoint.ts`): previously untested branches (config-loader
 * failure, git-spawn failure, non-hex rev-parse output, malformed checkpoints
 * log, generations beyond 20, fresh-head reconcile) plus the maxBuffer
 * forwarding pin. Split from auto-checkpoint-collision-2582.test.ts for the
 * FR-006 500-line cap.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { tryAcquireLock } from '../../../src/parallel/file-locks.js';
import {
	_internals as autoCheckpointInternals,
	buildAutoCheckpointLabel,
	maybeSaveAutoCheckpoint,
} from '../../../src/plan/auto-checkpoint.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const ORIGINAL_LOADER = autoCheckpointInternals.loadPluginConfigWithMeta;
const ORIGINAL_SPAWN_SYNC = autoCheckpointInternals.spawnSync;

let tempDir: string;
let isolatedEnv: { cleanup: () => void } | undefined;

const IDENTITY = {
	swarm: 'auto-checkpoint-2582',
	title: 'Auto Checkpoint Plan',
};

interface EntryLike {
	label: string;
	sha: string;
	timestamp: string;
}

function gitRun(directory: string, args: string[]): string {
	const result = child_process.spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed: ${result.stderr?.trim() ?? result.status}`,
		);
	}
	return result.stdout ?? '';
}

function gitInit(directory: string): void {
	gitRun(directory, ['init']);
	gitRun(directory, ['config', 'user.email', 'test@example.com']);
	gitRun(directory, ['config', 'user.name', 'Test User']);
	fs.writeFileSync(path.join(directory, 'seed.txt'), 'seed', 'utf-8');
	gitRun(directory, ['add', '--all']);
	gitRun(directory, ['commit', '-m', 'seed']);
}

function writeCheckpointConfig(config: Record<string, unknown>): void {
	fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(tempDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(config, null, 2),
		'utf-8',
	);
}

function seedLog(entries: EntryLike[]): void {
	fs.writeFileSync(
		path.join(tempDir, '.swarm', 'checkpoints.json'),
		JSON.stringify({ version: 1, checkpoints: entries }, null, 2),
		'utf-8',
	);
}

function readCheckpointEntries(): EntryLike[] {
	const logPath = path.join(tempDir, '.swarm', 'checkpoints.json');
	if (!fs.existsSync(logPath)) return [];
	const parsed = JSON.parse(fs.readFileSync(logPath, 'utf-8')) as {
		checkpoints?: EntryLike[];
	};
	return parsed.checkpoints ?? [];
}

function completedPlan(): never {
	return {
		...IDENTITY,
		phases: [
			{
				id: 1,
				name: 'Phase One',
				status: 'pending',
				tasks: [
					{ id: '1.1', status: 'completed' },
					{ id: '1.2', status: 'completed' },
				],
			},
		],
	} as never;
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('auto-checkpoint-hardening-2582-');
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(tempDir, '.swarm', 'spec.md'),
		'# Spec\n\n## FR-001\n\nThe system SHALL checkpoint.\n',
		'utf-8',
	);
	process.env.SWARM_SKIP_SPEC_GATE = '1';
	process.env.SWARM_SKIP_GATE_SELECTION = '1';
	isolatedEnv = createIsolatedTestEnv();
});

afterEach(() => {
	autoCheckpointInternals.loadPluginConfigWithMeta = ORIGINAL_LOADER;
	autoCheckpointInternals.spawnSync = ORIGINAL_SPAWN_SYNC;
	try {
		isolatedEnv?.cleanup();
	} catch {
		// best-effort
	}
	delete process.env.SWARM_SKIP_SPEC_GATE;
	delete process.env.SWARM_SKIP_GATE_SELECTION;
	try {
		closeProjectDb(tempDir);
	} catch {
		// best-effort
	}
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('auto-checkpoint review-hardening branches (#2582/#2864)', () => {
	test('a config loader throw falls back to defaults and still saves (PRR-003)', async () => {
		gitInit(tempDir);
		autoCheckpointInternals.loadPluginConfigWithMeta = () => {
			throw new Error('injected loader failure');
		};
		// Defaults apply: threshold 3 with a 2-completed plan → below boundary.
		const below = await maybeSaveAutoCheckpoint(tempDir, completedPlan());
		expect(below.saved).toBe(false);
		expect(below.skipReason).toBe('below_threshold');
		// A 3-completed plan crosses the default-3 boundary and saves.
		const three = {
			...IDENTITY,
			phases: [
				{
					id: 1,
					name: 'Phase One',
					status: 'pending',
					tasks: [
						{ id: '1.1', status: 'completed' },
						{ id: '1.2', status: 'completed' },
						{ id: '1.3', status: 'completed' },
					],
				},
			],
		} as never;
		const onBoundary = await maybeSaveAutoCheckpoint(tempDir, three);
		expect(onBoundary.saved).toBe(true);
		expect(onBoundary.label).toMatch(/-003$/);
	});

	test('a throwing git spawn skips with no_restorable_head (t-c-005)', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 1 },
		});
		autoCheckpointInternals.spawnSync = () => {
			throw new Error('injected spawn failure');
		};
		const outcome = await maybeSaveAutoCheckpoint(tempDir, completedPlan());
		expect(outcome.saved).toBe(false);
		expect(outcome.skipReason).toBe('no_restorable_head');
		expect(readCheckpointEntries()).toHaveLength(0);
	});

	test('non-hex rev-parse output is rejected (t-c-004)', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 1 },
		});
		const spawnCalls: Array<{ cmd: string; opts?: { maxBuffer?: number } }> =
			[];
		autoCheckpointInternals.spawnSync = ((
			cmd: string,
			args: string[],
			opts?: { maxBuffer?: number },
		) => {
			spawnCalls.push({ cmd, opts });
			return {
				status: 0,
				stdout: 'definitely-not-a-sha',
				stderr: '',
			};
		}) as unknown as typeof autoCheckpointInternals.spawnSync;
		const outcome = await maybeSaveAutoCheckpoint(tempDir, completedPlan());
		expect(outcome.saved).toBe(false);
		expect(outcome.skipReason).toBe('no_restorable_head');
		expect(readCheckpointEntries()).toHaveLength(0);
		// F11: the bounded-execution option is forwarded on every spawn.
		expect(spawnCalls.length).toBeGreaterThan(0);
		for (const call of spawnCalls) {
			expect(call.opts?.maxBuffer).toBe(1024 * 1024);
		}
	});

	test('a non-array checkpoints log is tolerated and the base label saves (PRR-005)', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 1 },
		});
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'checkpoints.json'),
			JSON.stringify({ version: 1, checkpoints: { bad: true } }),
			'utf-8',
		);
		const outcome = await maybeSaveAutoCheckpoint(tempDir, completedPlan());
		expect(outcome.saved).toBe(true);
		expect(outcome.label).toBe(buildAutoCheckpointLabel(IDENTITY, 2));
		expect(readCheckpointEntries()).toHaveLength(1);
	});

	test('generations beyond 20 are family and the next free one saves (PRR-001/PRR-004)', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: {
				enabled: true,
				auto_checkpoint_threshold: 1,
				max_retention: 30,
			},
		});
		const baseLabel = buildAutoCheckpointLabel(IDENTITY, 2);
		const oldSha = '0'.repeat(40);
		const familyLabels: EntryLike[] = [];
		for (let generation = 1; generation <= 21; generation++) {
			const label =
				generation === 1 ? baseLabel : `${baseLabel}-g${generation}`;
			familyLabels.push({
				label,
				sha: oldSha,
				timestamp: '2026-01-01T00:00:00.000Z',
			});
		}
		seedLog(familyLabels);
		const outcome = await maybeSaveAutoCheckpoint(tempDir, completedPlan());
		// No exhaustion cap: the next free generation (-g22) saves.
		expect(outcome.saved).toBe(true);
		expect(outcome.label).toBe(`${baseLabel}-g22`);
		expect(readCheckpointEntries()).toHaveLength(22);
	});

	test('reconcile matches a family entry at the re-resolved fresh head (F2)', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 1 },
		});
		const head = gitRun(tempDir, ['rev-parse', 'HEAD']).trim();
		const baseLabel = buildAutoCheckpointLabel(IDENTITY, 2);
		// The live log holds the family entry at the REAL head; the first
		// probe (call 1) reports a stale SHA_A so the pre-check misses; the
		// reconcile re-resolve (call 2) reports the real head.
		const SHA_A = 'a'.repeat(40);
		seedLog([
			{
				label: baseLabel,
				sha: head,
				timestamp: '2026-01-01T00:00:00.000Z',
			},
		]);
		let call = 0;
		autoCheckpointInternals.spawnSync = ((
			cmd: string,
			args: string[],
			opts?: { maxBuffer?: number },
		) => {
			call += 1;
			const sha = call === 1 ? SHA_A : head;
			return {
				status: 0,
				stdout: `${sha}
`,
				stderr: '',
			};
		}) as unknown as typeof autoCheckpointInternals.spawnSync;

		// Hold the checkpoints lock so the save hits its busy-failure path and
		// the reconcile runs; release as soon as the lock retry loop ends.
		const held = await tryAcquireLock(
			tempDir,
			'.swarm/checkpoints.json',
			'test-holder',
			'test',
		);
		try {
			const outcomeP = maybeSaveAutoCheckpoint(tempDir, completedPlan());
			const outcome = await outcomeP;
			// The save failed (lock busy) but the reconcile found the family
			// entry at the FRESH head — quiet idempotent no-op, not a warning.
			expect(outcome.saved).toBe(true);
			expect(outcome.skipReason).toBe('already_current');
			// The returned label is the one whose save lost the race (-g2);
			// the base entry it reconciled against is untouched.
			expect(outcome.label).toBe(`${baseLabel}-g2`);
			expect(readCheckpointEntries()).toHaveLength(1);
		} finally {
			await held.lock._release();
		}
	});

	test('zero-padded -g01 is not family (t-c-010)', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 1 },
		});
		const head = gitRun(tempDir, ['rev-parse', 'HEAD']).trim();
		const baseLabel = buildAutoCheckpointLabel(IDENTITY, 2);
		seedLog([
			{
				label: `${baseLabel}-g01`,
				sha: head,
				timestamp: '2026-01-01T00:00:00.000Z',
			},
		]);
		// '01' normalizes to generation 1 (< 2): not family, base stays free.
		const g01 = await maybeSaveAutoCheckpoint(tempDir, completedPlan());
		expect(g01.saved).toBe(true);
		expect(g01.label).toBe(baseLabel);
	});
});
