import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	recordStageAGateRoute,
	stageARouteAttemptClass,
} from '../../../src/hooks/guardrails/stage-a-route';
import { CATALOG_KINDS } from '../../../src/observability/catalog';
import { extractWorkflowIds } from '../../../src/observability/legacy';
import {
	EXECUTION_ATTEMPT_CLASSES,
	recordExecutionAttempt,
} from '../../../src/services/execution-attempt';
import {
	addTelemetryListener,
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

type Captured = { event: string; data: Record<string, unknown> };

let directory = '';
let events: Captured[] = [];

function attemptEvents(): Captured[] {
	return events.filter((e) => e.event === 'execution_attempt_recorded');
}

beforeEach(() => {
	resetTelemetryForTesting();
	directory = canonicalMkdtemp('exec-attempt-2676-');
	initTelemetry(directory);
	events = [];
	addTelemetryListener((event, data) => {
		events.push({ event, data: data as Record<string, unknown> });
	});
});

afterEach(() => {
	resetTelemetryForTesting();
	safeRmRecursive(directory);
});

describe('execution-attempt records — issue #2676 AC1', () => {
	test('the kind is catalogued and the class vocabulary is closed at seven', () => {
		expect(CATALOG_KINDS.includes('execution_attempt_recorded')).toBe(true);
		expect([...EXECUTION_ATTEMPT_CLASSES]).toEqual([
			'denial',
			'attempt',
			'result',
			'duplicate',
			'late',
			'cancelled',
			'provider_failed',
		]);
	});

	test('a valid record carries the exact join set it was given', () => {
		recordExecutionAttempt({
			sessionId: 'sess-1',
			taskId: 'task-1',
			callId: 'call-1',
			invocationId: 'inv-1',
			generation: 3,
			retryIndex: 1,
			attemptClass: 'result',
			outcomeStatus: 'success',
		});
		const captured = attemptEvents();
		expect(captured.length).toBe(1);
		const data = captured[0].data;
		expect(data.sessionId).toBe('sess-1');
		expect(data.taskId).toBe('task-1');
		expect(data.callId).toBe('call-1');
		expect(data.invocationId).toBe('inv-1');
		expect(data.generation).toBe(3);
		expect(data.retryIndex).toBe(1);
		expect(data.attemptClass).toBe('result');
		expect(data.outcomeStatus).toBe('success');
	});

	test('capture coverage is explicit: held joins listed captured, absent listed unknown', () => {
		recordExecutionAttempt({
			sessionId: 'sess-1',
			attemptClass: 'attempt',
		});
		const data = attemptEvents()[0].data;
		const captured = data.captured as string[];
		const unknown = data.unknown as string[];
		expect(captured).toContain('sessionId');
		for (const axis of [
			'taskId',
			'callId',
			'invocationId',
			'generation',
			'retryIndex',
		]) {
			expect(captured.includes(axis)).toBe(false);
			expect(unknown.includes(axis)).toBe(true);
		}
	});

	test('a class outside the closed vocabulary is refused fail-open (no event)', () => {
		recordExecutionAttempt({
			sessionId: 'sess-1',
			// @ts-expect-error deliberately invalid class
			attemptClass: 'definitely_not_a_class',
		});
		expect(attemptEvents().length).toBe(0);
	});

	test('late without a generation cursor is refused fail-open', () => {
		recordExecutionAttempt({
			sessionId: 'sess-1',
			attemptClass: 'late',
		});
		expect(attemptEvents().length).toBe(0);
	});

	test('late with a generation cursor is recorded and carries it', () => {
		recordExecutionAttempt({
			sessionId: 'sess-1',
			callId: 'call-1',
			generation: 7,
			attemptClass: 'late',
		});
		const captured = attemptEvents();
		expect(captured.length).toBe(1);
		expect(captured[0].data.generation).toBe(7);
	});

	test('duplicate without an original identity is refused fail-open', () => {
		recordExecutionAttempt({
			sessionId: 'sess-1',
			attemptClass: 'duplicate',
		});
		expect(attemptEvents().length).toBe(0);
	});

	test('generation 0 is a legal cursor (boundary: accepted, not refused)', () => {
		recordExecutionAttempt({
			sessionId: 'sess-1',
			callId: 'call-1',
			generation: 0,
			attemptClass: 'late',
		});
		const captured = attemptEvents();
		expect(captured.length).toBe(1);
		expect(captured[0].data.generation).toBe(0);
	});

	test("duplicateOf '' is refused fail-open (boundedId rejects empty)", () => {
		recordExecutionAttempt({
			sessionId: 'sess-1',
			attemptClass: 'duplicate',
			duplicateOf: '',
		});
		expect(attemptEvents().length).toBe(0);
	});

	test('duplicate with duplicateOf is recorded and never synthesizes one', () => {
		recordExecutionAttempt({
			sessionId: 'sess-1',
			attemptClass: 'duplicate',
			duplicateOf: 'record-abc123',
		});
		const captured = attemptEvents();
		expect(captured.length).toBe(1);
		expect(captured[0].data.duplicateOf).toBe('record-abc123');
	});

	test('provider_failed records its class with an unknown-honest cost block (fixture drive)', () => {
		recordExecutionAttempt({
			sessionId: 'sess-1',
			taskId: 'task-1',
			callId: 'call-1',
			invocationId: 'inv-1',
			attemptClass: 'provider_failed',
			outcomeStatus: 'failure',
		});
		const captured = attemptEvents();
		expect(captured.length).toBe(1);
		const data = captured[0].data;
		expect(data.attemptClass).toBe('provider_failed');
		expect(data.outcomeStatus).toBe('failure');
		expect(data.taskId).toBe('task-1');
		expect(data.callId).toBe('call-1');
		// The class is fixture-only today (no production seam holds the
		// provider/transient classification at emit time) — but the recorder
		// must still accept it with all cost axes unknown, never zero.
		const cost = data.cost as Record<string, unknown>;
		expect(cost.latencyMs).toBeNull();
		expect(cost.inputTokens).toBeNull();
		expect((cost.unavailable as string[]).length).toBe(6);
	});

	test('a record with no session identity is refused fail-open', () => {
		recordExecutionAttempt({ attemptClass: 'result' });
		expect(attemptEvents().length).toBe(0);
	});

	test('Stage A casing aliases normalize to the lowercase join keys', () => {
		recordExecutionAttempt({
			sessionID: 'sess-cased',
			callID: 'call-cased',
			attemptClass: 'denial',
		});
		const captured = attemptEvents();
		expect(captured.length).toBe(1);
		expect(captured[0].data.sessionId).toBe('sess-cased');
		expect(captured[0].data.callId).toBe('call-cased');
	});

	test('extractWorkflowIds maps callId and invocationId onto the envelope axes', () => {
		const ids = extractWorkflowIds({
			sessionId: 'sess-1',
			callId: 'call-9',
			invocationId: 'inv-9',
		});
		expect(ids.callId).toBe('call-9');
		expect(ids.invocationId).toBe('inv-9');
		expect(ids.hostSessionId).toBe('sess-1');
		// Absence stays absent — never synthesized.
		const empty = extractWorkflowIds({ sessionId: 'sess-1' });
		expect(empty.callId).toBeUndefined();
		expect(empty.invocationId).toBeUndefined();
	});
});

describe('execution-attempt records — real Stage A handler drive (AC1)', () => {
	test('recordStageAGateRoute emits the mapped execution-attempt record', () => {
		recordStageAGateRoute(directory, {
			route: 'pre_check_failed',
			sessionID: 'stage-a-sess',
			callID: 'stage-a-call',
			taskId: null,
			guardrailsEnabled: true,
		});
		const captured = attemptEvents();
		expect(captured.length).toBe(1);
		const data = captured[0].data;
		expect(data.attemptClass).toBe('denial');
		expect(data.sessionId).toBe('stage-a-sess');
		expect(data.callId).toBe('stage-a-call');
		expect(data.outcomeStatus).toBe('unknown');
	});

	test('valid_pass maps to the completed call outcome record (result/success)', () => {
		recordStageAGateRoute(directory, {
			route: 'valid_pass',
			sessionID: 'stage-a-sess',
			callID: 'stage-a-call',
			taskId: '1.1',
			guardrailsEnabled: true,
		});
		const data = attemptEvents()[0].data;
		expect(data.attemptClass).toBe('result');
		expect(data.outcomeStatus).toBe('success');
		expect(data.taskId).toBe('1.1');
	});

	test('late_result without a generation cursor is honestly refused', () => {
		recordStageAGateRoute(directory, {
			route: 'late_result',
			sessionID: 'stage-a-sess',
			callID: 'stage-a-call',
			taskId: null,
			guardrailsEnabled: true,
		});
		expect(attemptEvents().length).toBe(0);
	});

	test('late_result with the threaded generation records the late class', () => {
		recordStageAGateRoute(directory, {
			route: 'late_result',
			sessionID: 'stage-a-sess',
			callID: 'stage-a-call',
			taskId: null,
			guardrailsEnabled: true,
			generation: 4,
		});
		const captured = attemptEvents();
		expect(captured.length).toBe(1);
		expect(captured[0].data.attemptClass).toBe('late');
		expect(captured[0].data.generation).toBe(4);
	});

	test('the route-to-class mapping covers the closed route vocabulary', () => {
		expect(stageARouteAttemptClass('valid_pass')).toBe('result');
		expect(stageARouteAttemptClass('pre_check_failed')).toBe('denial');
		expect(stageARouteAttemptClass('invalid_result')).toBe('denial');
		expect(stageARouteAttemptClass('no_task_correlation')).toBe('denial');
		expect(stageARouteAttemptClass('attribution_ambiguous')).toBe('denial');
		expect(stageARouteAttemptClass('late_result')).toBe('late');
		expect(stageARouteAttemptClass('duplicate_result')).toBe('duplicate');
	});
});
