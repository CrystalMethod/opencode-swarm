/**
 * PR event subscriber delivery tests for ordinary matching subscriptions.
 *
 * The shared DI harness keeps each test file isolated when Bun co-runs files.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _internals } from '../../../src/background/pr-event-subscribers';
import {
	type MockState,
	makeConfig,
	makeMockSession,
	makeSubscription,
	restoreInternals,
	setupMocks,
	TEST_DIR,
} from '../../helpers/pr-event-subscribers-shared';

let mockState: MockState;
let savedInternals: typeof _internals;

beforeEach(() => {
	({ mockState, savedInternals } = setupMocks());
});

afterEach(() => {
	restoreInternals(savedInternals);
});

describe('handlePrEvent — matching subscription delivery', () => {
	test('delivers pr.ci.failed advisory to subscribed session', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					prUrl: 'https://github.com/owner/repo/pull/42',
					checkName: 'ci/build',
					checkState: 'failure',
					errorMessage: 'test error',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.pendingAdvisoryMessages[0]).toContain('pr.ci.failed');
		expect(session.pendingAdvisoryMessages[0]).toContain('ci/build');
		expect(session.pendingAdvisoryMessages[0]).toContain('failed');
		expect(session.pendingAdvisoryMessages[0]).toContain(
			'[pr-monitor:pr.ci.failed:owner/repo#42]',
		);
	});

	test('delivers pr.new.comment advisory to subscribed session', async () => {
		const session = makeMockSession('sess2');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({
				sessionID: 'sess2',
				prNumber: 99,
				repoFullName: 'org/repo',
				prUrl: 'https://github.com/org/repo/pull/99',
				correlationId: 'sess2::org/repo::99',
			}),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		await _internals.handlePrEvent(
			{
				type: 'pr.new.comment',
				payload: {
					prNumber: 99,
					repoFullName: 'org/repo',
					prUrl: 'https://github.com/org/repo/pull/99',
					author: 'reviewer',
					body: 'LGTM!',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.pendingAdvisoryMessages[0]).toContain('pr.new.comment');
		expect(session.pendingAdvisoryMessages[0]).toContain('@reviewer');
		expect(session.pendingAdvisoryMessages[0]).toContain('LGTM!');
		// B8 (issue #1976): content events carry a per-event identity suffix.
		expect(session.pendingAdvisoryMessages[0]).toContain(
			'[pr-monitor:pr.new.comment:org/repo#99',
		);
	});

	test('issue #1976 B8: N distinct comments on one PR produce N advisories (not 1)', async () => {
		// The legacy per-PR dedup token collapsed all comments on a PR to a single
		// advisory (N comments → 1 advisory, N−1 silently dropped). The per-event
		// identity suffix (@author:content-hash) lets distinct comments survive.
		const session = makeMockSession('sess-b8');
		mockState.listActive.mockResolvedValue([
			makeSubscription({ sessionID: 'sess-b8' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		const comments = [
			{ author: 'alice', body: 'looks good' },
			{ author: 'bob', body: 'please fix the typo' },
			{ author: 'alice', body: 'fixed, rebased' },
		];
		for (const c of comments) {
			await _internals.handlePrEvent(
				{
					type: 'pr.new.comment',
					payload: {
						prNumber: 42,
						repoFullName: 'owner/repo',
						prUrl: 'https://github.com/owner/repo/pull/42',
						author: c.author,
						body: c.body,
					},
				},
				TEST_DIR,
				makeConfig(),
			);
		}

		// Three distinct comments → three distinct per-event tokens → three advisories.
		expect(session.pendingAdvisoryMessages).toHaveLength(3);
	});

	test('issue #1976 B8: an identical re-delivered comment is deduped', async () => {
		// Per-event identity still suppresses a byte-identical re-delivery of the
		// SAME comment (same author + same body → same token).
		const session = makeMockSession('sess-b8b');
		mockState.listActive.mockResolvedValue([
			makeSubscription({ sessionID: 'sess-b8b' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		const payload = {
			prNumber: 42,
			repoFullName: 'owner/repo',
			prUrl: 'https://github.com/owner/repo/pull/42',
			author: 'alice',
			body: 'same comment twice',
		};
		await _internals.handlePrEvent(
			{ type: 'pr.new.comment', payload },
			TEST_DIR,
			makeConfig(),
		);
		await _internals.handlePrEvent(
			{ type: 'pr.new.comment', payload },
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
	});

	test('delivers pr.merge.conflict advisory to subscribed session', async () => {
		const session = makeMockSession('sess3');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({
				sessionID: 'sess3',
				prNumber: 10,
				repoFullName: 'myorg/myrepo',
				prUrl: 'https://github.com/myorg/myrepo/pull/10',
				correlationId: 'sess3::myorg/myrepo::10',
			}),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		await _internals.handlePrEvent(
			{
				type: 'pr.merge.conflict',
				payload: {
					prNumber: 10,
					repoFullName: 'myorg/myrepo',
					prUrl: 'https://github.com/myorg/myrepo/pull/10',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.pendingAdvisoryMessages[0]).toContain('pr.merge.conflict');
		expect(session.pendingAdvisoryMessages[0]).toContain(
			'Merge conflict detected',
		);
		expect(session.pendingAdvisoryMessages[0]).toContain('CONFLICTING');
		expect(session.pendingAdvisoryMessages[0]).toContain(
			'[pr-monitor:pr.merge.conflict:myorg/myrepo#10]',
		);
	});

	test('does not deliver when no matching subscription exists', async () => {
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({
				prNumber: 999,
				repoFullName: 'other/repo',
			}),
		]);

		const session = makeMockSession('sess1');
		mockState.getAgentSession.mockReturnValue(session as any);

		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	test('does not deliver when session not found', async () => {
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(undefined);

		// Should not throw, should not add any messages
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(mockState.log).toHaveBeenCalledWith(
			expect.stringContaining('Session sess1 not found'),
		);
	});
});
