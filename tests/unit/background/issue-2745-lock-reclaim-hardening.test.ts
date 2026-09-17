/**
 * Lock-reclamation hardening regressions for the #2745 review round.
 *
 * Loop-state and queue mutexes must (a) reclaim an alive-looking owner once
 * the lock age makes PID reuse the only credible explanation, and (b) never
 * let a non-ENOENT removal failure (Windows EPERM from an external open
 * handle, or a directory-shaped intruder) escape the acquire path as a raw
 * error — the acquire loop converts it into its bounded BLOCKED outcome.
 */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals as queueInternals } from '../../../src/background/pr-feedback-event-queue.js';
import { _internals as loopInternals } from '../../../src/background/pr-feedback-loop.js';
import { acquireLoopInternals } from '../../../tests/helpers/loop-internals-lease';
import { acquirePrFeedbackQueueLease } from '../../../tests/helpers/pr-feedback-queue-lease';
import {
	loopStateLockPath,
	makeProject,
	SESSION,
} from './issue-2745-state-safety-fixtures';

const NOW = 3_000_000_000;
const ALIVE_CEILING_MS = 10 * 60_000;

const originalLoopNow = loopInternals.now;
const originalLoopAlive = loopInternals.isProcessAlive;
const originalQueueNowMs = queueInternals.nowMs;
const originalQueueAlive = queueInternals.isProcessAlive;

/**
 * Lease acquisition, clock pinning, and seam restoration happen INSIDE each
 * test body (never in hooks): the shared fixtures module runs its own
 * queue-lease beforeEach/afterEach, and a lease held across hook boundaries
 * can deadlock against them.
 */
function lockTest(name: string, work: () => Promise<void>): void {
	test(name, async () => {
		const releaseLoop = await acquireLoopInternals();
		const releaseQueue = await acquirePrFeedbackQueueLease();
		try {
			// Pinned clocks: the age comparisons run against the module clock
			// seams, never the wall clock.
			loopInternals.now = () => NOW;
			queueInternals.nowMs = () => NOW;
			await work();
		} finally {
			loopInternals.now = originalLoopNow;
			loopInternals.isProcessAlive = originalLoopAlive;
			queueInternals.nowMs = originalQueueNowMs;
			queueInternals.isProcessAlive = originalQueueAlive;
			releaseQueue();
			releaseLoop();
		}
	});
}

function writeLockFile(lockPath: string, body: unknown): void {
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	fs.writeFileSync(lockPath, JSON.stringify(body), 'utf8');
}

// utimesSync takes epoch seconds; fixed arithmetic against the pinned module
// clock keeps this file clear of the real-clock gate and deterministic.
function ageMtimeSeconds(target: string, ageMs: number): void {
	const seconds = (NOW - ageMs) / 1000;
	fs.utimesSync(target, seconds, seconds);
}

function queueLockPath(dir: string): string {
	return path.join(dir, queueInternals.queueLockRelativePath(SESSION));
}

lockTest('an uninitialized loop-state lock is age-reclaimed', async () => {
	const dir = makeProject();
	const lockPath = loopStateLockPath(dir);
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	fs.writeFileSync(lockPath, 'not-json', 'utf8');
	ageMtimeSeconds(lockPath, 60_000);

	expect(await loopInternals.reclaimAbandonedLoopStateLock(lockPath)).toBe(
		true,
	);
	expect(fs.existsSync(lockPath)).toBe(false);
});

lockTest('a recent uninitialized loop-state lock is left alone', async () => {
	const dir = makeProject();
	const lockPath = loopStateLockPath(dir);
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	fs.writeFileSync(lockPath, 'not-json', 'utf8');
	ageMtimeSeconds(lockPath, 1_000);

	expect(await loopInternals.reclaimAbandonedLoopStateLock(lockPath)).toBe(
		false,
	);
	expect(fs.existsSync(lockPath)).toBe(true);
});

lockTest(
	'a loop-state lock whose alive owner passed the age ceiling is reclaimed as PID reuse',
	async () => {
		const dir = makeProject();
		const lockPath = loopStateLockPath(dir);
		writeLockFile(lockPath, {
			ownerToken: 'zombie-owner',
			pid: process.pid,
			createdAtMs: NOW - (ALIVE_CEILING_MS + 60_000),
		});
		// Real production liveness binding: this process genuinely owns the PID,
		// so the only reclaim path is the alive-owner age ceiling.
		expect(loopInternals.isProcessAlive(process.pid)).toBe(true);

		expect(await loopInternals.reclaimAbandonedLoopStateLock(lockPath)).toBe(
			true,
		);
		expect(fs.existsSync(lockPath)).toBe(false);
	},
);

lockTest('a young alive-PID loop-state lock is preserved', async () => {
	const dir = makeProject();
	const lockPath = loopStateLockPath(dir);
	writeLockFile(lockPath, {
		ownerToken: 'live-owner',
		pid: process.pid,
		createdAtMs: NOW - 1_000,
	});

	expect(await loopInternals.reclaimAbandonedLoopStateLock(lockPath)).toBe(
		false,
	);
	expect(fs.existsSync(lockPath)).toBe(true);
});

lockTest(
	'a queue lock whose alive owner passed the age ceiling is reclaimed as PID reuse',
	async () => {
		const dir = makeProject();
		const lockPath = queueLockPath(dir);
		writeLockFile(lockPath, {
			ownerToken: 'zombie-owner',
			pid: process.pid,
			createdAtMs: NOW - (ALIVE_CEILING_MS + 60_000),
		});
		expect(queueInternals.isProcessAlive(process.pid)).toBe(true);

		expect(await queueInternals.reclaimAbandonedQueueLock(lockPath)).toBe(true);
		expect(fs.existsSync(lockPath)).toBe(false);
	},
);

lockTest(
	'an unreadable (directory-shaped) lock is never reclaimed and never throws',
	async () => {
		const dir = makeProject();
		const lockPath = loopStateLockPath(dir);
		fs.mkdirSync(lockPath, { recursive: true });
		ageMtimeSeconds(lockPath, 60_000);

		expect(await loopInternals.reclaimAbandonedLoopStateLock(lockPath)).toBe(
			false,
		);
		expect(fs.existsSync(lockPath)).toBe(true);
		// Ownership cannot be verified on an unreadable lock, so the owned-removal
		// helper must refuse without throwing.
		expect(
			await loopInternals.removeLoopStateLockIfOwned(lockPath, 'any-token'),
		).toBe(false);
		expect(fs.existsSync(lockPath)).toBe(true);
	},
);
