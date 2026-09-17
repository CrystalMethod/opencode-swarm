/**
 * Phase 1 PR event subscriber registration and advisory formatting tests.
 *
 * The shared DI harness keeps each test file isolated when Bun co-runs files.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	type PrEventSubscriberOptions,
	registerPrEventSubscribers,
} from '../../../src/background/pr-event-subscribers';
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

describe('PrEventSubscriberOptions — construction', () => {
	test('has expected shape', () => {
		const opts: PrEventSubscriberOptions = {
			directory: TEST_DIR,
			config: makeConfig() as PrEventSubscriberOptions['config'],
		};
		expect(opts.directory).toBe(TEST_DIR);
		expect(opts.config).toBeDefined();
	});
});

describe('registerPrEventSubscribers', () => {
	test('registers subscribers for all enabled event types', () => {
		const cleanup = registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig() as PrEventSubscriberOptions['config'],
		});

		// The legacy 3 flags gate 4 event types: notify_merge_conflict also
		// gates pr.merge.conflict_resolved. The other flags (review/merged/
		// closed/ci_success) are unset in makeConfig → skipped.
		expect(mockState.busInstance.subscribe).toHaveBeenCalledTimes(4);
		expect(mockState.busInstance.subscribe).toHaveBeenCalledWith(
			'pr.ci.failed',
			expect.any(Function),
		);
		expect(mockState.busInstance.subscribe).toHaveBeenCalledWith(
			'pr.new.comment',
			expect.any(Function),
		);
		expect(mockState.busInstance.subscribe).toHaveBeenCalledWith(
			'pr.merge.conflict',
			expect.any(Function),
		);
		expect(mockState.busInstance.subscribe).toHaveBeenCalledWith(
			'pr.merge.conflict_resolved',
			expect.any(Function),
		);

		cleanup();
	});

	test('skips subscriber when notify_ci_failure config flag is false', () => {
		registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig({
				notify_ci_failure: false,
			}) as PrEventSubscriberOptions['config'],
		});

		// 3 event types subscribed (new_comment + merge_conflict + conflict_resolved)
		expect(mockState.busInstance.subscribe).toHaveBeenCalledTimes(3);

		const subscribedTypes = mockState.busInstance.subscribe.mock.calls.map(
			(c: unknown[]) => c[0],
		);
		expect(subscribedTypes).not.toContain('pr.ci.failed');
		expect(subscribedTypes).toContain('pr.new.comment');
		expect(subscribedTypes).toContain('pr.merge.conflict');
		expect(subscribedTypes).toContain('pr.merge.conflict_resolved');
	});

	test('skips subscriber when notify_new_comments config flag is false', () => {
		registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig({
				notify_new_comments: false,
			}) as PrEventSubscriberOptions['config'],
		});

		expect(mockState.busInstance.subscribe).toHaveBeenCalledTimes(3);
		const subscribedTypes = mockState.busInstance.subscribe.mock.calls.map(
			(c: unknown[]) => c[0],
		);
		expect(subscribedTypes).toContain('pr.ci.failed');
		expect(subscribedTypes).not.toContain('pr.new.comment');
		expect(subscribedTypes).toContain('pr.merge.conflict');
		expect(subscribedTypes).toContain('pr.merge.conflict_resolved');
	});

	test('skips subscriber when notify_merge_conflict config flag is false', () => {
		registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig({
				notify_merge_conflict: false,
			}) as PrEventSubscriberOptions['config'],
		});

		expect(mockState.busInstance.subscribe).toHaveBeenCalledTimes(2);
		const subscribedTypes = mockState.busInstance.subscribe.mock.calls.map(
			(c: unknown[]) => c[0],
		);
		expect(subscribedTypes).toContain('pr.ci.failed');
		expect(subscribedTypes).toContain('pr.new.comment');
		expect(subscribedTypes).not.toContain('pr.merge.conflict');
		expect(subscribedTypes).not.toContain('pr.merge.conflict_resolved');
	});

	test('skips all subscribers when all config flags are false', () => {
		registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig({
				notify_ci_failure: false,
				notify_new_comments: false,
				notify_merge_conflict: false,
			}) as PrEventSubscriberOptions['config'],
		});

		expect(mockState.busInstance.subscribe).not.toHaveBeenCalled();
	});

	test('cleanup function unsubscribes all listeners', () => {
		const mockUnsubscribe1 = mock(() => {});
		const mockUnsubscribe2 = mock(() => {});
		const mockUnsubscribe3 = mock(() => {});

		mockState.busInstance.subscribe
			.mockReturnValueOnce(mockUnsubscribe1)
			.mockReturnValueOnce(mockUnsubscribe2)
			.mockReturnValueOnce(mockUnsubscribe3);

		const cleanup = registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig() as PrEventSubscriberOptions['config'],
		});

		cleanup();

		expect(mockUnsubscribe1).toHaveBeenCalledTimes(1);
		expect(mockUnsubscribe2).toHaveBeenCalledTimes(1);
		expect(mockUnsubscribe3).toHaveBeenCalledTimes(1);
	});
});

describe('formatAdvisory', () => {
	const ciFailedPayload = {
		prNumber: 42,
		repoFullName: 'owner/repo',
		prUrl: 'https://github.com/owner/repo/pull/42',
		checkName: 'ci/build',
		checkState: 'failure',
		errorMessage: 'Build failed',
	};

	const newCommentPayload = {
		prNumber: 42,
		repoFullName: 'owner/repo',
		prUrl: 'https://github.com/owner/repo/pull/42',
		author: 'reviewer',
		body: 'Looks good!',
	};

	const mergeConflictPayload = {
		prNumber: 42,
		repoFullName: 'owner/repo',
		prUrl: 'https://github.com/owner/repo/pull/42',
	};

	test('pr.ci.failed advisory contains dedup token', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		await _internals.handlePrEvent(
			{ type: 'pr.ci.failed', payload: ciFailedPayload },
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages[0]).toContain(
			'[pr-monitor:pr.ci.failed:owner/repo#42]',
		);
	});

	test('pr.new.comment advisory contains dedup token', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		await _internals.handlePrEvent(
			{ type: 'pr.new.comment', payload: newCommentPayload },
			TEST_DIR,
			makeConfig(),
		);

		// B8 (issue #1976): content events (comments/reviews) carry a per-event
		// identity suffix (@author:hash) before the closing bracket, so assert
		// the stable token PREFIX rather than the exact per-PR token.
		expect(session.pendingAdvisoryMessages[0]).toContain(
			'[pr-monitor:pr.new.comment:owner/repo#42',
		);
	});

	test('pr.merge.conflict advisory contains dedup token', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		await _internals.handlePrEvent(
			{ type: 'pr.merge.conflict', payload: mergeConflictPayload },
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages[0]).toContain(
			'[pr-monitor:pr.merge.conflict:owner/repo#42]',
		);
	});

	test('unknown event type returns null and does not deliver', async () => {
		const session = makeMockSession('sess1');
		mockState.listActive.mockResolvedValueOnce([
			makeSubscription({ sessionID: 'sess1' }),
		]);
		mockState.getAgentSession.mockReturnValue(session as any);

		await _internals.handlePrEvent(
			{
				type: 'pr.unknown.event',
				payload: { prNumber: 42, repoFullName: 'owner/repo' },
			},
			TEST_DIR,
			makeConfig(),
		);

		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});
});
