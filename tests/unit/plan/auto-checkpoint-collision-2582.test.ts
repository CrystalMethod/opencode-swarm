/**
 * Issue #2582 — trigger-level label-collision tests for the
 * `checkpoint.auto_checkpoint_threshold` runtime consumer
 * (`src/plan/auto-checkpoint.ts`): prior-epoch collisions save a fresh `-gN`
 * generation, racing concurrent triggers reconcile instead of warning, and
 * manual labels that merely share the family prefix (or its length) are never
 * mistaken for automatic entries. Split from
 * manager-auto-checkpoint-2582.test.ts for the FR-006 500-line cap.
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
	tempDir = canonicalMkdtemp('auto-checkpoint-collision-2582-');
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(tempDir, '.swarm', 'spec.md'),
		'# Spec\n\n## FR-001\n\nThe system SHALL checkpoint.\n',
		'utf-8',
	);
	process.env.SWARM_SKIP_SPEC_GATE = '1';
	isolatedEnv = createIsolatedTestEnv();
	process.env.SWARM_SKIP_GATE_SELECTION = '1';
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

describe('auto-checkpoint label collisions (#2582)', () => {
	test('prior-epoch label collision saves a fresh generation instead of losing the checkpoint', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 2 },
		});
		const identity = {
			swarm: 'auto-checkpoint-2582',
			title: 'Auto Checkpoint Plan',
		};
		const head = gitRun(tempDir, ['rev-parse', 'HEAD']).trim();
		const baseLabel = buildAutoCheckpointLabel(identity, 2);
		const seedLog = (sha: string, label = baseLabel) => {
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'checkpoints.json'),
				JSON.stringify(
					{
						version: 1,
						checkpoints: [
							{ label, sha, timestamp: '2026-01-01T00:00:00.000Z' },
						],
					},
					null,
					2,
				),
				'utf-8',
			);
		};
		const plan = {
			...identity,
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
		const { maybeSaveAutoCheckpoint: maybeSave } = await import(
			'../../../src/plan/auto-checkpoint.js'
		);

		// A prior-epoch entry at the same identity+count with a DIFFERENT sha
		// (the final critic's live-probed collision): the fresh boundary must
		// save under the next label generation, not be swallowed by the
		// duplicate-label rejection.
		seedLog('0'.repeat(40));
		const collided = await maybeSave(tempDir, plan);
		expect(collided.saved).toBe(true);
		expect(collided.label).toBe(`${baseLabel}-g2`);
		expect(readCheckpointEntries()).toHaveLength(2);

		// A prior family entry at the CURRENT sha is an idempotent replay: no
		// duplicate entry, quiet success.
		seedLog(head, `${baseLabel}-g3`);
		const replayed = await maybeSave(tempDir, plan);
		expect(replayed.saved).toBe(true);
		expect(replayed.skipReason).toBe('already_current');
		expect(readCheckpointEntries()).toHaveLength(1);
	});

	test('concurrent triggers on one boundary never surface a duplicate-label warning', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 2 },
		});
		const plan = {
			swarm: 'auto-checkpoint-2582',
			title: 'Auto Checkpoint Plan',
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
		const { maybeSaveAutoCheckpoint: maybeSave } = await import(
			'../../../src/plan/auto-checkpoint.js'
		);

		// All racing calls resolve the same base label lock-free; a loser's
		// duplicate-label failure must reconcile against the now-live log
		// instead of becoming an operator warning.
		const outcomes = await Promise.all([
			maybeSave(tempDir, plan),
			maybeSave(tempDir, plan),
			maybeSave(tempDir, plan),
		]);
		for (const outcome of outcomes) {
			expect(outcome.saved).toBe(true);
			expect(outcome.warning).toBeUndefined();
		}
		expect(readCheckpointEntries()).toHaveLength(1);
	});

	test('a manual label sharing the family prefix is not mistaken for an automatic entry', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 2 },
		});
		const identity = {
			swarm: 'auto-checkpoint-2582',
			title: 'Auto Checkpoint Plan',
		};
		const head = gitRun(tempDir, ['rev-parse', 'HEAD']).trim();
		const baseLabel = buildAutoCheckpointLabel(identity, 2);
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'checkpoints.json'),
			JSON.stringify(
				{
					version: 1,
					checkpoints: [
						// A manually-created label that merely starts with the family
						// prefix must NOT satisfy the automatic boundary.
						{
							label: `${baseLabel}-garbage`,
							sha: head,
							timestamp: '2026-01-01T00:00:00.000Z',
						},
					],
				},
				null,
				2,
			),
			'utf-8',
		);
		const plan = {
			...identity,
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
		const { maybeSaveAutoCheckpoint: maybeSave } = await import(
			'../../../src/plan/auto-checkpoint.js'
		);

		const outcome = await maybeSave(tempDir, plan);
		expect(outcome.saved).toBe(true);
		expect(outcome.label).toBe(baseLabel);
		expect(readCheckpointEntries()).toHaveLength(2);
	});

	test('an unrelated same-length label ending in -g2 is not family', async () => {
		gitInit(tempDir);
		writeCheckpointConfig({
			checkpoint: { enabled: true, auto_checkpoint_threshold: 2 },
		});
		const identity = {
			swarm: 'auto-checkpoint-2582',
			title: 'Auto Checkpoint Plan',
		};
		const head = gitRun(tempDir, ['rev-parse', 'HEAD']).trim();
		const baseLabel = buildAutoCheckpointLabel(identity, 2);
		// Same LENGTH as the base label and ending in -g2, but a different
		// prefix entirely — the slice-based parser must reject it.
		const stranger = 'z'.repeat(baseLabel.length - 3) + '-g2';
		expect(stranger.endsWith('-g2')).toBe(true);
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'checkpoints.json'),
			JSON.stringify(
				{
					version: 1,
					checkpoints: [
						{
							label: stranger,
							sha: head,
							timestamp: '2026-01-01T00:00:00.000Z',
						},
					],
				},
				null,
				2,
			),
			'utf-8',
		);
		const plan = {
			...identity,
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
		const { maybeSaveAutoCheckpoint: maybeSave } = await import(
			'../../../src/plan/auto-checkpoint.js'
		);

		const outcome = await maybeSave(tempDir, plan);
		expect(outcome.saved).toBe(true);
		expect(outcome.skipReason).not.toBe('already_current');
		expect(outcome.label).toBe(baseLabel);
		expect(readCheckpointEntries()).toHaveLength(2);
	});
});
