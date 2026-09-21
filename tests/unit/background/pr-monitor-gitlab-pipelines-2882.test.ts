/**
 * Issue #2882 — GitLab pipeline verdicts surface through the EXISTING event
 * vocabulary (pr.ci.failed / pr.ci.passed) with transition detection keyed on
 * the existing lastCheckRunSet machinery; non-terminal statuses produce no
 * event; a pipelines fetch failure preserves prior CI transition state.
 *
 * Drives pollSinglePr through the worker _internals seam (no real glab spawn).
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import type { MRPollSnapshot } from '../../../src/git/pr';
import { getProviderCapabilities } from '../../../src/providers/forge-provider';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const workerMod = await import('../../../src/background/pr-monitor-worker');
const saved = { ...workerMod._internals };

const dirs: string[] = [];
const emitted: Array<{ type: string; payload: unknown }> = [];

function makeConfiguredProject(baseUrl: string): string {
	const dir = canonicalMkdtemp('mr-pipelines-2882-');
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ forge: { provider: 'gitlab', base_url: baseUrl } }),
	);
	return dir;
}

// Windows runners can hold a transient lock on a freshly written temp dir;
// a leftover %TEMP% entry is preferable to failing a passing test.
function bestEffortRm(dir: string): void {
	try {
		safeRmRecursive(dir);
	} catch {
		// best-effort: teardown cleanup only
	}
}

function fakeMrSnapshot(overrides: Partial<MRPollSnapshot>): MRPollSnapshot {
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
		...overrides,
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

let snapshots: Record<string, unknown> = {};

beforeEach(() => {
	emitted.length = 0;
	snapshots = {};
	workerMod._internals.getMRPollSnapshot = (async () =>
		currentSnapshot as MRPollSnapshot) as typeof workerMod._internals.getMRPollSnapshot;
	workerMod._internals.getMRComments =
		(async () => []) as typeof workerMod._internals.getMRComments;
	workerMod._internals.getPRPollSnapshot = (async () => {
		throw new Error('gh poll must not run for GitLab subscriptions');
	}) as typeof workerMod._internals.getPRPollSnapshot;
	workerMod._internals.updateSnapshot = (async (
		_directory: string,
		correlationId: string,
		updates: Record<string, unknown>,
	) => {
		snapshots[correlationId] = {
			...(snapshots[correlationId] ?? {}),
			...updates,
		};
		// The real store persists updates back onto the record; mirror that so
		// subsequent polls observe the recorded transition key (lastCheckRunSet).
		if (currentSubRef.current) Object.assign(currentSubRef.current, updates);
		return null;
	}) as unknown as typeof workerMod._internals.updateSnapshot;
	workerMod._internals.getGlobalEventBus = (() => ({
		publish: async (type: string, payload: unknown) => {
			emitted.push({ type, payload });
		},
	})) as unknown as typeof workerMod._internals.getGlobalEventBus;
});

let currentSnapshot: MRPollSnapshot = fakeMrSnapshot({});
const currentSubRef: { current: Record<string, unknown> | null } = {
	current: null,
};

afterAll(() => {
	Object.assign(workerMod._internals, saved);
	for (const d of dirs.splice(0)) {
		closeAllProjectDbs();
		bestEffortRm(d);
	}
});

function makeWorker() {
	const dir = makeConfiguredProject('https://git.example.internal');
	dirs.push(dir);
	return new workerMod.PrMonitorWorker({
		directory: dir,
		config: {
			enabled: true,
			notify_ci_failed: true,
			notify_ci_passed: true,
		} as never,
	});
}

async function poll(worker: unknown, sub: unknown): Promise<void> {
	currentSubRef.current = sub;
	const p = (
		worker as {
			pollSinglePr: (
				sub: unknown,
				isTimedOut?: () => boolean,
				isProbe?: boolean,
			) => Promise<void>;
		}
	).pollSinglePr.bind(worker);
	await p(sub, () => false, true);
}

describe('pipeline → CI event mapping (#2882 AC2)', () => {
	test('success pipeline transition emits pr.ci.passed through the existing vocabulary', async () => {
		const worker = makeWorker();
		const sub = makeSub();
		// First poll records the terminal-success set (no events on first poll,
		// matching GitHub semantics).
		currentSnapshot = fakeMrSnapshot({
			pipelines: [
				{ name: 'pipeline #42', status: 'completed', conclusion: 'success' },
			],
		});
		await poll(worker, sub);
		expect(emitted.filter((e) => e.type === 'pr.ci.passed')).toHaveLength(0);
		expect(snapshots[sub.correlationId]?.lastCheckRunSet).toBe(
			JSON.stringify([{ n: 'pipeline #42', c: 'success' }]),
		);

		// Second poll: pipeline regressed to failure → pr.ci.failed.
		currentSnapshot = fakeMrSnapshot({
			pipelines: [
				{ name: 'pipeline #43', status: 'completed', conclusion: 'failure' },
			],
		});
		await poll(worker, sub);
		const failed = emitted.filter((e) => e.type === 'pr.ci.failed');
		expect(failed).toHaveLength(1);
		const payload = failed[0]?.payload as { failedChecks: unknown };
		expect(payload.failedChecks).toEqual([
			{ name: 'pipeline #43', conclusion: 'failure' },
		]);

		// Third poll: back to success → pr.ci.passed with checkCount.
		currentSnapshot = fakeMrSnapshot({
			pipelines: [
				{ name: 'pipeline #44', status: 'completed', conclusion: 'success' },
			],
		});
		await poll(worker, sub);
		const passed = emitted.filter((e) => e.type === 'pr.ci.passed');
		expect(passed).toHaveLength(1);
		expect((passed[0]?.payload as { checkCount: number }).checkCount).toBe(1);
	});

	test('non-terminal pipeline statuses produce no CI event fuel', async () => {
		const worker = makeWorker();
		const sub = makeSub();
		// Empty terminal set on every poll: no transitions, no events, but the
		// transition key is still recorded (honest "no verdict yet").
		currentSnapshot = fakeMrSnapshot({ pipelines: [] });
		await poll(worker, sub);
		await poll(worker, sub);
		expect(emitted.filter((e) => e.type.startsWith('pr.ci.'))).toHaveLength(0);
		expect(snapshots[sub.correlationId]?.lastCheckRunSet).toBe('[]');
	});

	test('pipelines fetch failure preserves prior CI transition state', async () => {
		const worker = makeWorker();
		const sub = makeSub();
		currentSnapshot = fakeMrSnapshot({
			pipelines: [
				{ name: 'pipeline #10', status: 'completed', conclusion: 'failure' },
			],
		});
		await poll(worker, sub);
		const priorKey = snapshots[sub.correlationId]?.lastCheckRunSet;
		expect(priorKey).toContain('failure');

		// Fetch fails: snapshot stands, lastCheckRunSet must NOT be overwritten.
		currentSnapshot = fakeMrSnapshot({
			pipelines: [],
			pipelinesFetchSucceeded: false,
		});
		await poll(worker, sub);
		expect(snapshots[sub.correlationId]?.lastCheckRunSet).toBe(priorKey);
		// No CI events were synthesized from the degraded fetch either.
		expect(emitted.filter((e) => e.type.startsWith('pr.ci.'))).toHaveLength(0);
	});

	test('capability contract holds: the three synthesized fields stay unavailable (AC9)', () => {
		const caps = getProviderCapabilities('gitlab');
		expect(caps).toEqual({
			statusCheckRollup: false,
			reviewDecision: false,
			mergeStateStatus: false,
		});
	});
});
