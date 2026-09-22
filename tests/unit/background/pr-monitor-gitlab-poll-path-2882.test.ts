/**
 * Issue #2882 — pollSinglePr provider-aware routing contract:
 *  - GitLab subscriptions (gitlab.com AND declared generic hosts) poll via the
 *    glab pipeline; the gh fetchers are never invoked for them.
 *  - The three GitHub-synthesized fields stay honestly-unavailable in the
 *    produced events/snapshot state; getProviderCapabilities is unchanged.
 *  - MR comments flow through the existing pr.new.comment vocabulary and the
 *    state/merge events use the real GitLab mappings.
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
const mrInputs: string[] = [];
let ghPollAttempts = 0;

function makeProject(): string {
	const dir = canonicalMkdtemp('mr-pollpath-2882-');
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

function bestEffortRm(dir: string): void {
	try {
		safeRmRecursive(dir);
	} catch {
		// best-effort: teardown cleanup only
	}
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

beforeEach(() => {
	emitted.length = 0;
	mrInputs.length = 0;
	ghPollAttempts = 0;
	workerMod._internals.getMRPollSnapshot = (async (input: {
		projectPath: string;
		iid: number;
		host?: string;
	}) => {
		mrInputs.push(`${input.projectPath}!${input.iid}@${input.host ?? 'none'}`);
		return fakeSnapshot();
	}) as unknown as typeof workerMod._internals.getMRPollSnapshot;
	workerMod._internals.getMRComments = (async () => [
		{
			id: 'c1',
			author: 'alice',
			body: 'hello',
			createdAt: '2026-09-01T10:00:00Z',
			isReviewComment: false,
		},
	]) as typeof workerMod._internals.getMRComments;
	workerMod._internals.getPRPollSnapshot = (async () => {
		ghPollAttempts++;
		throw new Error('gh poll must not run for GitLab subscriptions');
	}) as typeof workerMod._internals.getPRPollSnapshot;
	workerMod._internals.getPRReviewComments = (async () => {
		ghPollAttempts++;
		throw new Error('gh comments must not run for GitLab subscriptions');
	}) as typeof workerMod._internals.getPRReviewComments;
	workerMod._internals.updateSnapshot = (async () =>
		null) as unknown as typeof workerMod._internals.updateSnapshot;
	workerMod._internals.getGlobalEventBus = (() => ({
		publish: async (type: string, payload: unknown) => {
			emitted.push({ type, payload });
		},
	})) as unknown as typeof workerMod._internals.getGlobalEventBus;
});

afterAll(() => {
	Object.assign(workerMod._internals, saved);
	for (const d of dirs.splice(0)) {
		closeAllProjectDbs();
		bestEffortRm(d);
	}
});

function makeWorker(): { worker: unknown; dir: string } {
	const dir = makeProject();
	dirs.push(dir);
	const worker = new workerMod.PrMonitorWorker({
		directory: dir,
		config: { enabled: true, notify_new_comment: true } as never,
	});
	return { worker, dir };
}

function makeSub(overrides: Record<string, unknown> = {}) {
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
		...overrides,
	};
}

describe('pollSinglePr glab routing (#2882 AC4)', () => {
	test('declared generic-host subscription polls the glab path with its forge host', async () => {
		const { worker } = makeWorker();
		await (
			worker as {
				pollSinglePr: (
					sub: unknown,
					isTimedOut?: () => boolean,
					isProbe?: boolean,
				) => Promise<void>;
			}
		).pollSinglePr(makeSub(), () => false, true);
		expect(ghPollAttempts).toBe(0);
		expect(mrInputs).toEqual(['team/proj!7@git.example.internal']);
		// First poll: all comments are new → existing pr.new.comment vocabulary.
		const comments = emitted.filter((e) => e.type === 'pr.new.comment');
		expect(comments).toHaveLength(1);
		expect((comments[0]?.payload as { author: string }).author).toBe('alice');
		// Synthesized-field honesty: no CI events from the empty rollup, and no
		// review events from the '' decision.
		expect(emitted.filter((e) => e.type.startsWith('pr.ci.'))).toHaveLength(0);
		expect(emitted.filter((e) => e.type.startsWith('pr.review.'))).toHaveLength(
			0,
		);
	});

	test('gitlab.com shape-detected subscription also routes via glab (no forge field needed)', async () => {
		const { worker } = makeWorker();
		const sub = makeSub({
			correlationId: 'sess::acme/app::9',
			prNumber: 9,
			repoFullName: 'acme/app',
			prUrl: 'https://gitlab.com/acme/app/-/merge_requests/9',
			forge: undefined,
		});
		await (
			worker as {
				pollSinglePr: (
					sub: unknown,
					isTimedOut?: () => boolean,
					isProbe?: boolean,
				) => Promise<void>;
			}
		).pollSinglePr(sub, () => false, true);
		expect(mrInputs).toEqual(['acme/app!9@gitlab.com']);
		expect(ghPollAttempts).toBe(0);
	});

	test('merged MR maps through the real GitLab state vocabulary', async () => {
		const { worker } = makeWorker();
		workerMod._internals.getMRPollSnapshot = (async () => ({
			...fakeSnapshot(),
			status: { ...fakeSnapshot().status, state: 'MERGED' },
		})) as unknown as typeof workerMod._internals.getMRPollSnapshot;
		await (
			worker as {
				pollSinglePr: (sub: unknown) => Promise<void>;
			}
		).pollSinglePr(makeSub());
		const merged = emitted.filter((e) => e.type === 'pr.merged');
		expect(merged).toHaveLength(1);
	});

	test('capabilities stay the honest-unavailable source of truth (unchanged)', () => {
		expect(getProviderCapabilities('gitlab')).toEqual({
			statusCheckRollup: false,
			reviewDecision: false,
			mergeStateStatus: false,
		});
		expect(getProviderCapabilities('github')).toEqual({
			statusCheckRollup: true,
			reviewDecision: true,
			mergeStateStatus: true,
		});
	});
});
