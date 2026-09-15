/**
 * Phase 1 PR Event Subscribers tests.
 *
 * Tests: registerPrEventSubscribers, handlePrEvent, formatAdvisory.
 * Uses _internals DI seam for full mock isolation â€” no cross-file pollution.
 *
 * The _internals seam is added to pr-event-subscribers.ts specifically for
 * testing: it exposes handlePrEvent, getGlobalEventBus, listActive,
 * getAgentSession, and log so tests can replace them with mocks.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	type PrEventSubscriberOptions,
	registerPrEventSubscribers,
} from '../../../src/background/pr-event-subscribers';
import type { PrSubscriptionRecord } from '../../../src/background/pr-subscriptions';
import { acquirePrFeedbackBackgroundLease } from '../../../tests/helpers/pr-feedback-background-lease';

// â”€â”€ Test Fixtures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const TEST_DIR = path.join(os.tmpdir(), 'pr-event-subscribers-test');

function makeConfig(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		notify_ci_failure: true,
		notify_new_comments: true,
		notify_merge_conflict: true,
		auto_pr_feedback: false,
		...overrides,
	};
}

function makeSubscription(
	overrides: Partial<PrSubscriptionRecord> = {},
): PrSubscriptionRecord {
	const repoFullName = overrides.repoFullName ?? 'owner/repo';
	const prNumber = overrides.prNumber ?? 42;
	return {
		correlationId: 'sess1::owner/repo::42',
		sessionID: 'sess1',
		prNumber,
		repoFullName,
		prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
		lastCheckedAt: 940_000,
		isWatching: true,
		hasUnaddressedEvents: false,
		status: 'active',
		createdAt: 880_000,
		updatedAt: 940_000,
		errorCount: 0,
		...overrides,
	};
}

// â”€â”€ Mock State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface MockState {
	listActive: ReturnType<typeof mock>;
	getAgentSession: ReturnType<typeof mock>;
	readPrWorkflowGateState: ReturnType<typeof mock>;
	activatePrWorkflow: ReturnType<typeof mock>;
	enqueuePrFeedbackMonitorEvent: ReturnType<typeof mock>;
	log: ReturnType<typeof mock>;
	getGlobalEventBus: ReturnType<typeof mock>;
	scheduleClearUnaddressed: ReturnType<typeof mock>;
	busInstance: {
		subscribe: ReturnType<typeof mock>;
	};
}

let mockState: MockState;
let savedInternals: typeof _internals;
let releaseBackground: (() => void) | null = null;

function setupMocks(): void {
	savedInternals = { ..._internals };

	mockState = {
		listActive: mock(() => Promise.resolve([])),
		getAgentSession: mock(() => undefined),
		readPrWorkflowGateState: mock(() => Promise.resolve(null)),
		activatePrWorkflow: mock(() =>
			Promise.resolve({ mode: 'PR_FEEDBACK', prFeedbackInventory: undefined }),
		),
		enqueuePrFeedbackMonitorEvent: mock(() => Promise.resolve(undefined)),
		log: mock(() => {}),
		getGlobalEventBus: mock(() => mockState.busInstance),
		scheduleClearUnaddressed: mock(() => {}),
		busInstance: {
			subscribe: mock(() => () => {}),
		},
	};

	_internals.listActive = mockState.listActive as typeof _internals.listActive;
	_internals.getAgentSession =
		mockState.getAgentSession as typeof _internals.getAgentSession;
	_internals.readPrWorkflowGateState =
		mockState.readPrWorkflowGateState as typeof _internals.readPrWorkflowGateState;
	_internals.activatePrWorkflow =
		mockState.activatePrWorkflow as typeof _internals.activatePrWorkflow;
	_internals.enqueuePrFeedbackMonitorEvent =
		mockState.enqueuePrFeedbackMonitorEvent as typeof _internals.enqueuePrFeedbackMonitorEvent;
	_internals.log = mockState.log as typeof _internals.log;
	_internals.getGlobalEventBus =
		mockState.getGlobalEventBus as typeof _internals.getGlobalEventBus;
	// No-op the deferred hasUnaddressedEvents clear so these tests never
	// schedule real timers / store writes.
	_internals.scheduleClearUnaddressed =
		mockState.scheduleClearUnaddressed as typeof _internals.scheduleClearUnaddressed;
}

function restoreInternals(): void {
	if (savedInternals) {
		_internals.listActive = savedInternals.listActive;
		_internals.getAgentSession = savedInternals.getAgentSession;
		_internals.readPrWorkflowGateState = savedInternals.readPrWorkflowGateState;
		_internals.activatePrWorkflow = savedInternals.activatePrWorkflow;
		_internals.enqueuePrFeedbackMonitorEvent =
			savedInternals.enqueuePrFeedbackMonitorEvent;
		_internals.log = savedInternals.log;
		_internals.getGlobalEventBus = savedInternals.getGlobalEventBus;
		_internals.scheduleClearUnaddressed =
			savedInternals.scheduleClearUnaddressed;
	}
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Create a mock session object that tracks pendingAdvisoryMessages.
 */
function makeMockSession(sessionId: string): {
	sessionID: string;
	pendingAdvisoryMessages: string[];
} {
	return {
		sessionID: sessionId,
		pendingAdvisoryMessages: [],
	};
}

// â”€â”€ Tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('PrEventSubscriberOptions â€” construction', () => {
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
	beforeEach(async () => {
		releaseBackground = await acquirePrFeedbackBackgroundLease();
		setupMocks();
	});

	afterEach(() => {
		try {
			restoreInternals();
		} finally {
			releaseBackground?.();
			releaseBackground = null;
		}
	});

	test('registers subscribers for all enabled event types', () => {
		const cleanup = registerPrEventSubscribers({
			directory: TEST_DIR,
			config: makeConfig() as PrEventSubscriberOptions['config'],
		});

		// The legacy 3 flags gate 4 event types: notify_merge_conflict also
		// gates pr.merge.conflict_resolved. The other flags (review/merged/
		// closed/ci_success) are unset in makeConfig â†’ skipped.
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
	beforeEach(async () => {
		releaseBackground = await acquirePrFeedbackBackgroundLease();
		setupMocks();
	});

	afterEach(() => {
		try {
			restoreInternals();
		} finally {
			releaseBackground?.();
			releaseBackground = null;
		}
	});

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
