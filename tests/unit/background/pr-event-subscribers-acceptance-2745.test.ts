import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from 'bun:test';
import {
	_internals,
	type PrEventSubscriberOptions,
} from '../../../src/background/pr-event-subscribers.js';
import type { PrSubscriptionRecord } from '../../../src/background/pr-subscriptions.js';
import { safeRmRecursive } from '../../../tests/helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir.js';

const FIXTURE_NOW = 2_000_000;
let directory = '';
let cleanupDirectory: () => void = () => {};
const prUrl = 'https://github.com/owner/repo/pull/42';

afterAll(() => {
	cleanupDirectory();
});

function config(
	overrides: Record<string, unknown> = {},
): PrEventSubscriberOptions['config'] {
	return {
		notify_ci_failure: true,
		notify_new_comments: true,
		notify_merge_conflict: true,
		notify_review_activity: true,
		notify_merged: true,
		notify_closed: true,
		auto_pr_feedback: true,
		event_delivery: 'advisory',
		...overrides,
	} as PrEventSubscriberOptions['config'];
}

function subscription(): PrSubscriptionRecord {
	return {
		correlationId: 'sess1::owner/repo::42',
		sessionID: 'sess1',
		prNumber: 42,
		repoFullName: 'owner/repo',
		prUrl,
		lastCheckedAt: FIXTURE_NOW,
		isWatching: true,
		hasUnaddressedEvents: true,
		status: 'active',
		createdAt: FIXTURE_NOW,
		updatedAt: FIXTURE_NOW,
		errorCount: 0,
	};
}

function event(type = 'pr.ci.failed') {
	return {
		type,
		payload: {
			prNumber: 42,
			repoFullName: 'owner/repo',
			prUrl,
			checkName: 'ci/build',
			checkState: 'failure',
		},
	};
}

let saved: typeof _internals;
let session:
	| { sessionID: string; pendingAdvisoryMessages: string[] }
	| undefined;
let notify: ReturnType<typeof mock>;

beforeEach(() => {
	if (!directory) {
		directory = canonicalMkdtemp('pr-subscriber-2745-');
		cleanupDirectory = () => safeRmRecursive(directory);
	}
	saved = { ..._internals };
	session = { sessionID: 'sess1', pendingAdvisoryMessages: [] };
	notify = mock(() => {});
	_internals.listActive = mock(async () => [subscription()]);
	_internals.getAgentSession = mock(() => session as never);
	_internals.readPrWorkflowGateState = mock(async () => null);
	_internals.activatePrWorkflow = mock(async () => ({
		mode: 'PR_FEEDBACK' as const,
	}));
	_internals.enqueuePrFeedbackMonitorEvent = mock(async () => undefined);
	_internals.notifyPrFeedbackLoop =
		notify as typeof _internals.notifyPrFeedbackLoop;
	_internals.isPrEventDeliveryRegistered = mock(() => false);
	_internals.deliverPrActivity = mock(async () => true);
	_internals.scheduleClearUnaddressed = mock(() => {});
	_internals.log = mock(() => {});
});

afterEach(() => {
	Object.assign(_internals, saved);
});

describe('subscriber delivery acceptance (#2745)', () => {
	test('notifies only after prompt delivery accepts and carries the mode signal', async () => {
		_internals.isPrEventDeliveryRegistered = mock(() => true);
		let deliveryFinished = false;
		_internals.deliverPrActivity = mock(async (_session, events, root) => {
			expect(root).toBe(directory);
			expect(events[0]?.message).toContain('[MODE: PR_FEEDBACK');
			expect(notify).not.toHaveBeenCalled();
			deliveryFinished = true;
			return true;
		});

		await _internals.handlePrEvent(
			event(),
			directory,
			config({ event_delivery: 'prompt' }),
		);

		expect(deliveryFinished).toBe(true);
		expect(notify).toHaveBeenCalledWith(directory, 'sess1');
	});

	test('treats an already queued advisory as accepted for settlement', async () => {
		session!.pendingAdvisoryMessages.push(
			'[pr-monitor:pr.ci.failed:owner/repo#42] prior advisory',
		);

		await _internals.handlePrEvent(event(), directory, config());

		expect(notify).toHaveBeenCalledWith(directory, 'sess1');
		expect(session!.pendingAdvisoryMessages).toHaveLength(1);
	});

	test('leaves the queued event unsettled when the session is missing', async () => {
		session = undefined;

		await _internals.handlePrEvent(event(), directory, config());

		expect(notify).not.toHaveBeenCalled();
	});

	test('does not settle when prompt delivery fails before advisory fallback has a session', async () => {
		session = undefined;
		_internals.isPrEventDeliveryRegistered = mock(() => true);
		_internals.deliverPrActivity = mock(async () => false);

		await _internals.handlePrEvent(
			event(),
			directory,
			config({ event_delivery: 'prompt' }),
		);

		expect(notify).not.toHaveBeenCalled();
	});
});
