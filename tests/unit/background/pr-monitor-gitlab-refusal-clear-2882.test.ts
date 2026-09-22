/**
 * Issue #2882 AC6 — store-write refusal accounting covers GitLab cycles.
 * Pre-fix, the GitLab skip returned BEFORE clearStoreWriteRefusal, so an
 * all-GitLab store with an active refusal could never clear it. With the glab
 * poll path live, a successful probe poll (seeded glab, worker-seam MR
 * fetchers) reaches the success path and clears the refusal.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrSubscriptionCapacityError } from '../../../src/background/pr-subscriptions';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import type { MRPollSnapshot } from '../../../src/git/pr';
import {
	__seedGlabExecutableForTests,
	resetGlabExecutableCache,
} from '../../../src/utils/glab-executable';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const workerMod = await import('../../../src/background/pr-monitor-worker');
const saved = { ...workerMod._internals };

const dirs: string[] = [];

function makeProject(): string {
	const dir = canonicalMkdtemp('mr-refusal-2882-');
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			forge: { provider: 'gitlab', base_url: 'https://git.example.internal' },
		}),
	);
	return dir;
}

function fakeSnapshot(): MRPollSnapshot {
	return {
		status: {
			number: 7,
			state: 'OPEN',
			mergeable: 'MERGEABLE',
			mergeStateStatus: 'NOT_AVAILABLE',
			headRefOid: 'sha-1',
			statusCheckRollup: [],
		},
		comments: [],
		merge: {
			mergeable: 'MERGEABLE',
			mergeStateStatus: 'NOT_AVAILABLE',
			headRefOid: 'sha-1',
		},
		review: { reviewDecision: '', reviewRequestCount: 0 },
		pipelines: [],
		pipelinesFetchSucceeded: true,
	};
}

function makeSub() {
	return {
		correlationId: 'sess::team/proj::7',
		sessionID: 'sess',
		prNumber: 7,
		repoFullName: 'team/proj',
		prUrl: 'https://git.example.internal/team/proj/-/merge_requests/7',
		forge: { provider: 'gitlab' as const, host: 'git.example.internal' },
		lastCheckedAt: 0,
		isWatching: true,
		hasUnaddressedEvents: false,
		status: 'active' as const,
		createdAt: 0,
		updatedAt: 0,
		errorCount: 0,
	};
}

interface RefusalWorker {
	pollSinglePr: (
		sub: unknown,
		isTimedOut?: () => boolean,
		isProbe?: boolean,
	) => Promise<void>;
	storeWriteRefusal: { lastReason: string } | null;
}

beforeEach(() => {
	resetGlabExecutableCache();
	// Seeded RESOLVED glab binary so the probe exercises the success path
	// (never the bare-name fallback).
	__seedGlabExecutableForTests('C:/seeded/glab.exe');
	workerMod._internals.getMRPollSnapshot = (async () =>
		fakeSnapshot()) as typeof workerMod._internals.getMRPollSnapshot;
	workerMod._internals.getMRComments =
		(async () => []) as typeof workerMod._internals.getMRComments;
	workerMod._internals.getGlobalEventBus = (() => ({
		publish: async () => undefined,
	})) as unknown as typeof workerMod._internals.getGlobalEventBus;
});

afterAll(() => {
	Object.assign(workerMod._internals, saved);
	resetGlabExecutableCache();
	for (const d of dirs.splice(0)) {
		closeAllProjectDbs();
		try {
			safeRmRecursive(d);
		} catch {
			// best-effort: teardown cleanup only
		}
	}
});

describe('store-write refusal clears on GitLab probe success (#2882 AC6)', () => {
	test('a successful glab-backed probe poll clears an active refusal', async () => {
		const dir = makeProject();
		dirs.push(dir);
		const worker = new workerMod.PrMonitorWorker({
			directory: dir,
			config: { enabled: true } as never,
		});

		// Activate the refusal the real way: a CAPACITY-classified store write
		// failure on a poll (the classifier is instance-based).
		let failWrites = true;
		workerMod._internals.updateSnapshot = (async (
			_directory: string,
			_correlationId: string,
		) => {
			if (failWrites) {
				throw new PrSubscriptionCapacityError('simulated capacity breach');
			}
			return null;
		}) as unknown as typeof workerMod._internals.updateSnapshot;

		const w = worker as unknown as RefusalWorker;
		await w.pollSinglePr(makeSub(), () => false, true);
		// The failed poll noted a refusal (or the poll errored into the
		// circuit-breaker path); the observable precondition is a non-null state.
		// Drive until the refusal is non-null (one failed poll suffices when the
		// store write is what failed; if the first poll already errored earlier,
		// retry once with the fetch succeeding).
		if (!w.storeWriteRefusal) {
			await w.pollSinglePr(makeSub(), () => false, true);
		}
		expect(w.storeWriteRefusal).not.toBeNull();

		// Store accepts writes again: the next (successful) GitLab poll must
		// clear the refusal — pre-fix this is where the skip returned early.
		failWrites = false;
		await w.pollSinglePr(makeSub(), () => false, true);
		expect(w.storeWriteRefusal).toBeNull();
	});
});
