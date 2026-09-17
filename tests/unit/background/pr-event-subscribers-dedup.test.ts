/**
 * PR event subscriber deduplication and malformed-payload tests.
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

describe('handlePrEvent — deduplication and payload handling', () => {
	test('deduplicates repeated events for same PR+type', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockReturnValue([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		// First event
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					checkName: 'ci/build',
					checkState: 'failure',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);

		// Same event again — should be deduplicated
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					checkName: 'ci/build',
					checkState: 'failure',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		// Still only 1 message (second was deduped)
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
	});

	test('dedup works correctly with interleaved different event types', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockReturnValue([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		// 1. Deliver pr.ci.failed → expect advisory delivered
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					checkName: 'ci/build',
					checkState: 'failure',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.pendingAdvisoryMessages[0]).toContain('pr.ci.failed');

		// 2. Deliver pr.new.comment → expect advisory delivered (different type)
		await _internals.handlePrEvent(
			{
				type: 'pr.new.comment',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					prUrl: 'https://github.com/owner/repo/pull/42',
					author: 'reviewer',
					body: 'LGTM',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		// Both messages should be present (different event types)
		expect(session.pendingAdvisoryMessages).toHaveLength(2);
		expect(session.pendingAdvisoryMessages[1]).toContain('pr.new.comment');

		// 3. Deliver pr.ci.failed again → expect DEDUPED (same type+PR, scanned from all messages)
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					checkName: 'ci/build',
					checkState: 'failure',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		// Still only 2 messages — the second ci.failed was deduped
		expect(session.pendingAdvisoryMessages).toHaveLength(2);
	});

	test('delivers to multiple sessions subscribed to same PR', async () => {
		const session1 = makeMockSession('sess1');
		const session2 = makeMockSession('sess2');
		const session3 = makeMockSession('sess3');

		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
			makeSubscription({
				sessionID: 'sess2',
				correlationId: 'sess2::owner/repo::42',
			}),
			makeSubscription({
				sessionID: 'sess3',
				correlationId: 'sess3::owner/repo::42',
			}),
		]);

		mockState.getAgentSession
			.mockReturnValueOnce(session1 as any)
			.mockReturnValueOnce(session2 as any)
			.mockReturnValueOnce(session3 as any);

		await _internals.handlePrEvent(
			{
				type: 'pr.merge.conflict',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					prUrl: 'https://github.com/owner/repo/pull/42',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session1.pendingAdvisoryMessages).toHaveLength(1);
		expect(session2.pendingAdvisoryMessages).toHaveLength(1);
		expect(session3.pendingAdvisoryMessages).toHaveLength(1);
	});

	test('handles event payload with missing fields gracefully', async () => {
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		const session = makeMockSession('sess1');
		mockState.getAgentSession.mockReturnValue(session as any);

		// Payload with only partial fields (prUrl missing, checkName missing)
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					// prUrl, checkName, errorMessage all missing
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		// Should still deliver a message with 'unknown' defaults
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.pendingAdvisoryMessages[0]).toContain('unknown');
		expect(session.pendingAdvisoryMessages[0]).toContain('owner/repo');
	});

	test('handles event payload with missing prNumber', async () => {
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		const session = makeMockSession('sess1');
		mockState.getAgentSession.mockReturnValue(session as any);

		// prNumber missing
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					repoFullName: 'owner/repo',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		// Should return early without delivering
		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	test('handles event payload with missing repoFullName', async () => {
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		const session = makeMockSession('sess1');
		mockState.getAgentSession.mockReturnValue(session as any);

		// repoFullName missing
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	test('does not dedupe different event types for same PR', async () => {
		const session = makeMockSession('sess1');
		// Use mockReturnValue (not mockResolvedValueOnce) because handlePrEvent
		// is called twice in this test and listActive must return subscriptions both times
		mockState.listActive.mockReturnValue([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		// First event: ci.failed
		await _internals.handlePrEvent(
			{
				type: 'pr.ci.failed',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					checkName: 'ci/build',
					checkState: 'failure',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);

		// Different event type: merge.conflict for same PR — should NOT be deduped
		await _internals.handlePrEvent(
			{
				type: 'pr.merge.conflict',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					prUrl: 'https://github.com/owner/repo/pull/42',
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		// Both messages should be present
		expect(session.pendingAdvisoryMessages).toHaveLength(2);
		const types = session.pendingAdvisoryMessages.map((m: string) =>
			m.includes('pr.ci.failed')
				? 'pr.ci.failed'
				: m.includes('pr.merge.conflict')
					? 'pr.merge.conflict'
					: 'other',
		);
		expect(types).toContain('pr.ci.failed');
		expect(types).toContain('pr.merge.conflict');
	});

	test('comment body is truncated to 200 characters', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		const longComment = 'A'.repeat(500);

		await _internals.handlePrEvent(
			{
				type: 'pr.new.comment',
				payload: {
					prNumber: 42,
					repoFullName: 'owner/repo',
					prUrl: 'https://github.com/owner/repo/pull/42',
					author: 'reviewer',
					body: longComment,
				},
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		// The message should contain only the first 200 chars of the comment
		const commentPart =
			session.pendingAdvisoryMessages[0].split('Comment: ')[1];
		expect(commentPart.length).toBe(200);
		expect(commentPart).toBe('A'.repeat(200));
	});
});
