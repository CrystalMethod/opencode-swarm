/**
 * Issue #2882 review round (PR #2895, F-2) — the PR feedback loop runtime's
 * GitLab head-evaluation branch:
 *  - routes GitLab subscriptions through getMRPollSnapshot with the resolved
 *    forge host;
 *  - uses URL-FIRST forge precedence (shape detection before the persisted
 *    declaration), so a tampered declaration host cannot override
 *    shape-detected gitlab.com hosts;
 *  - falls back to the gh path for GitHub subscriptions.
 * Closes the zero-coverage gap on the branch introduced for #2882.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { detectForgeFromUrl } from '../../../src/providers/forge-provider';

const runtimeMod = await import(
	'../../../src/background/pr-feedback-loop-runtime'
);
const saved = { ...runtimeMod._internals };

interface StubRecord {
	prUrl: string;
	forge?: { provider: 'gitlab'; host: string };
}

const calls: string[] = [];
let nextRecord: StubRecord | null = null;
let declaredHostSeen: string | undefined;
let mrHeadSha = 'mr-sha-1';

beforeEach(() => {
	calls.length = 0;
	nextRecord = null;
	declaredHostSeen = undefined;
	mrHeadSha = 'mr-sha-1';
	runtimeMod._internals.findSubscriptionRecordForPrUrl = (async () =>
		nextRecord) as unknown as typeof runtimeMod._internals.findSubscriptionRecordForPrUrl;
	runtimeMod._internals.getMRPollSnapshot = (async (input: {
		projectPath: string;
		iid: number;
		host?: string;
	}) => {
		calls.push(`mr:${input.projectPath}!${input.iid}@${input.host ?? 'none'}`);
		declaredHostSeen = input.host;
		return { status: { headRefOid: mrHeadSha } };
	}) as unknown as typeof runtimeMod._internals.getMRPollSnapshot;
	runtimeMod._internals.getPRPollSnapshot = (async () => {
		calls.push('gh');
		return { status: { headRefOid: 'gh-sha-1' } };
	}) as unknown as typeof runtimeMod._internals.getPRPollSnapshot;
});

afterAll(() => {
	Object.assign(runtimeMod._internals, saved);
});

function withRuntime(run: () => Promise<void>): Promise<void> {
	const reg = runtimeMod.registerPrFeedbackLoopRuntime({
		directory: process.cwd(),
	});
	return run().finally(() => {
		reg();
	});
}

describe('feedback-loop runtime GitLab head evaluation (#2895 F-2)', () => {
	test('gitlab.com URL routes via getMRPollSnapshot even with a tampered declaration host (URL-first precedence)', async () => {
		await withRuntime(async () => {
			nextRecord = {
				prUrl: 'https://gitlab.com/team/proj/-/merge_requests/7',
				// Tampered declaration: persisted-field-first would trust this host
				// and pass it to the glab spawn. URL-first must ignore it.
				forge: { provider: 'gitlab', host: 'attacker.example.net' },
			};
			const head = await runtimeMod.evaluatePrFeedbackCurrentHead(
				process.cwd(),
				'team/proj',
				7,
			);
			expect(head).toBe('mr-sha-1');
			expect(calls).toEqual(['mr:team/proj!7@gitlab.com']);
			expect(declaredHostSeen).toBe('gitlab.com');
			// Sanity: shape detection really answers for this URL.
			expect(
				detectForgeFromUrl('https://gitlab.com/team/proj/-/merge_requests/7'),
			).toEqual({ provider: 'gitlab', host: 'gitlab.com' });
		});
	});

	test('generic self-hosted URL uses the persisted declaration host', async () => {
		await withRuntime(async () => {
			nextRecord = {
				prUrl: 'https://git.example.internal/team/proj/-/merge_requests/7',
				forge: { provider: 'gitlab', host: 'git.example.internal' },
			};
			const head = await runtimeMod.evaluatePrFeedbackCurrentHead(
				process.cwd(),
				'team/proj',
				7,
			);
			expect(head).toBe('mr-sha-1');
			expect(calls).toEqual(['mr:team/proj!7@git.example.internal']);
		});
	});

	test('GitHub subscription keeps the gh path (control)', async () => {
		await withRuntime(async () => {
			nextRecord = { prUrl: 'https://github.com/owner/repo/pull/42' };
			const head = await runtimeMod.evaluatePrFeedbackCurrentHead(
				process.cwd(),
				'owner/repo',
				42,
			);
			expect(head).toBe('gh-sha-1');
			expect(calls).toEqual(['gh']);
		});
	});
});
