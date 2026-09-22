/**
 * Issue #2882 AC5 — configured forge context threads through the event
 * identity/dedup paths for declared generic self-hosted GitLab MR URLs:
 *  - findSubscriptionRecordForPrUrl resolves records (raw + record-scoped
 *    canonical matching; null on miss).
 *  - Queue admission (enqueue/normalize) accepts a declared generic-host URL
 *    WITH the record's forge declaration and stays fail-closed (BLOCKED)
 *    WITHOUT it.
 *  - claimPrFeedbackMonitorEvents matches queued generic-host events with the
 *    context.
 *  - activatePrWorkflow accepts a declared generic-host target with
 *    options.forge and rejects it fail-closed without.
 *  - Cross-domain boundary: a GitHub URL never canonicalizes under a gitlab
 *    configured context (PR_REVIEW handoff stays GitHub-only).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	claimPrFeedbackMonitorEvents,
	enqueuePrFeedbackMonitorEvent,
	readPrFeedbackMonitorQueue,
} from '../../../src/background/pr-feedback-event-queue';
import {
	findSubscriptionRecordForPrUrl,
	subscribe,
} from '../../../src/background/pr-subscriptions';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { activatePrWorkflow } from '../../../src/hooks/pr-workflow-gate';
import { canonicalForgePrUrl } from '../../../src/providers/forge-provider';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const dirs: string[] = [];
const GENERIC = 'https://git.example.internal/team/proj/-/merge_requests/7';
const FORGE = { provider: 'gitlab' as const, host: 'git.example.internal' };

function makeProject(): string {
	const dir = canonicalMkdtemp('gl-ctx-2882-');
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			forge: { provider: 'gitlab', base_url: 'https://git.example.internal' },
		}),
	);
	fs.mkdirSync(path.join(dir, '.swarm', 'pr-monitor'), { recursive: true });
	return dir;
}

afterAll(() => {
	for (const d of dirs.splice(0)) {
		closeAllProjectDbs();
		try {
			safeRmRecursive(d);
		} catch {
			// best-effort: teardown cleanup only
		}
	}
});

async function seedSubscription(dir: string): Promise<void> {
	await subscribe(dir, {
		sessionID: 'sess-ctx',
		prNumber: 7,
		repoFullName: 'team/proj',
		prUrl: GENERIC,
		forge: FORGE,
	});
}

describe('findSubscriptionRecordForPrUrl (#2882 AC5)', () => {
	test('resolves by (repoFullName, prNumber), by raw prUrl, and by record-scoped canonicalization', async () => {
		const dir = makeProject();
		dirs.push(dir);
		await seedSubscription(dir);

		const byIdentity = await findSubscriptionRecordForPrUrl(dir, {
			repoFullName: 'team/proj',
			prNumber: 7,
		});
		expect(byIdentity?.forge).toEqual(FORGE);

		// Same URL with different case/path shape: raw equality fails, but
		// record-scoped canonicalization (both sides under the record's forge)
		// still matches.
		const byCanon = await findSubscriptionRecordForPrUrl(dir, {
			prUrl: 'https://git.example.internal/Team/Proj/-/merge_requests/7',
		});
		expect(byCanon?.forge).toEqual(FORGE);

		const miss = await findSubscriptionRecordForPrUrl(dir, {
			prUrl: 'https://other.example.net/x/y/-/merge_requests/1',
		});
		expect(miss).toBeNull();
	});

	test('sessionID lookup falls through to the session own record when lookupByPr returns another session record (Copr round)', async () => {
		const dir = makeProject();
		dirs.push(dir);
		// Two sessions subscribed to the SAME MR is a supported scenario
		// (correlationId = session::repo::pr, so each session gets its own
		// record). lookupByPr ignores session and returns whichever record
		// sorts first — the session-scoped lookup must still find each
		// session's own record (Copr round: it used to fail closed).
		await subscribe(dir, {
			sessionID: 'sess-b',
			prNumber: 7,
			repoFullName: 'team/proj',
			prUrl: GENERIC,
			forge: FORGE,
		});
		await subscribe(dir, {
			sessionID: 'sess-a',
			prNumber: 7,
			repoFullName: 'team/proj',
			prUrl: GENERIC,
			forge: FORGE,
		});
		// Sanity: both records are active in the store.
		const a = await findSubscriptionRecordForPrUrl(dir, {
			repoFullName: 'team/proj',
			prNumber: 7,
			sessionID: 'sess-a',
		});
		const b = await findSubscriptionRecordForPrUrl(dir, {
			repoFullName: 'team/proj',
			prNumber: 7,
			sessionID: 'sess-b',
		});
		expect(a?.sessionID).toBe('sess-a');
		expect(b?.sessionID).toBe('sess-b');
	});
});

describe('queue admission + claim with configured context (#2882 AC5)', () => {
	test('generic-host event admits with the declaration, stays BLOCKED without it', async () => {
		const dir = makeProject();
		dirs.push(dir);

		await expect(
			enqueuePrFeedbackMonitorEvent(dir, 'sess-ctx', {
				type: 'pr.new.comment',
				repoFullName: 'team/proj',
				prNumber: 7,
				prUrl: GENERIC,
				message: 'm',
				dedupToken: 't1',
				authorized: false,
				queuedAt: '2026-09-21T00:00:00.000Z',
			}),
		).rejects.toThrow(/BLOCKED/);

		await enqueuePrFeedbackMonitorEvent(
			dir,
			'sess-ctx',
			{
				type: 'pr.new.comment',
				repoFullName: 'team/proj',
				prNumber: 7,
				prUrl: GENERIC,
				message: 'm',
				dedupToken: 't1',
				authorized: false,
				queuedAt: '2026-09-21T00:00:00.000Z',
			},
			FORGE,
		);
		const queue = await readPrFeedbackMonitorQueue(dir, 'sess-ctx');
		expect(queue?.events.map((e) => e.prUrl)).toContain(GENERIC);
	});

	test('claim gate accepts the generic-host URL with the context and claims its event', async () => {
		const dir = makeProject();
		dirs.push(dir);
		await enqueuePrFeedbackMonitorEvent(
			dir,
			'sess-claim',
			{
				type: 'pr.merge.conflict',
				repoFullName: 'team/proj',
				prNumber: 7,
				prUrl: GENERIC,
				message: 'm',
				dedupToken: 't2',
				authorized: false,
				queuedAt: '2026-09-21T00:00:00.000Z',
			},
			FORGE,
		);

		// Without the context the claim fails closed (canonical gate).
		await expect(
			claimPrFeedbackMonitorEvents(
				dir,
				'sess-claim',
				'wf-1',
				GENERIC,
				undefined,
				process.pid,
			),
		).rejects.toThrow(/BLOCKED/);

		const claimed = await claimPrFeedbackMonitorEvents(
			dir,
			'sess-claim',
			'wf-1',
			GENERIC,
			undefined,
			process.pid,
			FORGE,
		);
		expect(claimed.map((e) => e.dedupToken)).toEqual(['t2']);
	});
});

describe('PR_FEEDBACK activation with configured context (#2882 AC5)', () => {
	test('generic-host target activates with options.forge; rejects fail-closed without', async () => {
		const dir = makeProject();
		dirs.push(dir);

		await expect(
			activatePrWorkflow(dir, 'sess-act', 'PR_FEEDBACK', {
				prUrl: GENERIC,
			}),
		).rejects.toThrow(/BLOCKED/);

		const state = await activatePrWorkflow(dir, 'sess-act', 'PR_FEEDBACK', {
			prUrl: GENERIC,
			forge: FORGE,
		});
		expect(state.prFeedbackTargetUrl).toBe(GENERIC);
	});
});

describe('cross-domain boundary (#2882 AC5, PR_REVIEW handoff stays GitHub-only)', () => {
	test('a GitHub URL and a declared GitLab MR URL can never canonicalize equal (cross-domain boundary)', () => {
		// canonicalForgePrUrl is authorization-ADDITIVE: the configured context
		// admits the declared host but never rewrites other hosts. A GitHub
		// artifact URL therefore canonicalizes to its own value, which can never
		// equal a GitLab MR canonical value — the PR_REVIEW handoff (GitHub-only
		// domain) stays unmatched against GitLab targets in every comparison.
		const githubCanonical = canonicalForgePrUrl(
			'https://github.com/owner/repo/pull/42',
			FORGE,
		);
		const gitlabCanonical = canonicalForgePrUrl(GENERIC, FORGE);
		expect(githubCanonical).toBe('github.com/owner/repo/pull/42');
		expect(gitlabCanonical).toBe(
			'git.example.internal/team/proj/-/merge_requests/7',
		);
		expect(githubCanonical).not.toBe(gitlabCanonical);
		// The declared generic host still never canonicalizes under shape
		// detection alone (fail-closed without the declaration).
		expect(canonicalForgePrUrl(GENERIC)).toBeNull();
	});
});
