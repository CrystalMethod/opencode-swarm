import { mock } from 'bun:test';
import * as path from 'node:path';
import { _internals } from '../../src/background/pr-event-subscribers';
import type { PrSubscriptionRecord } from '../../src/background/pr-subscriptions';
import { canonicalTmpDir } from './tmpdir';

export const TEST_DIR = path.join(
	canonicalTmpDir(),
	'pr-event-subscribers-test',
);

export function makeConfig(
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

export function makeSubscription(
	overrides: Partial<PrSubscriptionRecord> = {},
): PrSubscriptionRecord {
	return {
		correlationId: 'sess1::owner/repo::42',
		sessionID: 'sess1',
		prNumber: 42,
		repoFullName: 'owner/repo',
		prUrl: 'https://github.com/owner/repo/pull/42',
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

export interface MockState {
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

export function setupMocks(): {
	mockState: MockState;
	savedInternals: typeof _internals;
} {
	const savedInternals = { ..._internals };
	const mockState: MockState = {
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

	return { mockState, savedInternals };
}

export function restoreInternals(savedInternals: typeof _internals): void {
	Object.assign(_internals, savedInternals);
}

export function makeMockSession(sessionId: string): {
	sessionID: string;
	pendingAdvisoryMessages: string[];
} {
	return {
		sessionID: sessionId,
		pendingAdvisoryMessages: [],
	};
}
