import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	emitDelegationBegin,
	emitDelegationEventlessTerminalEnd,
} from '../../../src/background/delegation-lifecycle';
import {
	buildTaskAttemptCost,
	TASK_ATTEMPT_COST_AXES,
} from '../../../src/services/execution-attempt';
import {
	buildTaskCohortReport,
	snapshotTaskAttemptCohort,
} from '../../../src/services/task-cohort';
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
	directory = canonicalMkdtemp('exec-attempt-cost-2676-');
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

describe('buildTaskAttemptCost — unknown is not zero (AC2)', () => {
	test('omitted axes are strictly null AND listed unavailable; known pass through verbatim', () => {
		const rec = buildTaskAttemptCost({
			taskId: 'task-1',
			attemptId: 'attempt-1',
			latencyMs: 1234,
			inputTokens: 100,
		});
		expect(rec.latencyMs).toBe(1234);
		expect(rec.inputTokens).toBe(100);
		for (const axis of [
			'outputTokens',
			'cacheReadTokens',
			'estimatedCostUsd',
			'billedCostUsd',
		]) {
			expect(rec[axis]).toBeNull();
			expect(rec.unavailable.includes(axis)).toBe(true);
		}
		for (const axis of ['latencyMs', 'inputTokens']) {
			expect(rec[axis]).not.toBeNull();
			expect(rec.unavailable.includes(axis)).toBe(false);
		}
	});

	test('zero is a legal KNOWN value, never produced for a missing input', () => {
		const rec = buildTaskAttemptCost({ inputTokens: 0 });
		expect(rec.inputTokens).toBe(0);
		expect(rec.unavailable.includes('inputTokens')).toBe(false);
		expect(rec.unavailable.includes('latencyMs')).toBe(true);
		expect(rec.latencyMs).toBeNull();
	});

	test('invalid values (negative, NaN, Infinity) count as not-held, not as zero', () => {
		const rec = buildTaskAttemptCost({
			latencyMs: Number.NaN,
			inputTokens: -5,
			outputTokens: Number.POSITIVE_INFINITY,
		});
		expect(rec.latencyMs).toBeNull();
		expect(rec.inputTokens).toBeNull();
		expect(rec.outputTokens).toBeNull();
		for (const axis of ['latencyMs', 'inputTokens', 'outputTokens']) {
			expect(rec.unavailable.includes(axis)).toBe(true);
		}
	});

	test('an empty input marks every axis unavailable', () => {
		const rec = buildTaskAttemptCost({});
		expect([...TASK_ATTEMPT_COST_AXES]).toEqual([
			'latencyMs',
			'inputTokens',
			'outputTokens',
			'cacheReadTokens',
			'estimatedCostUsd',
			'billedCostUsd',
		]);
		expect(rec.unavailable).toEqual([...TASK_ATTEMPT_COST_AXES]);
	});

	test('historical nulls stay null through a re-fold (never manufactured)', () => {
		const original = buildTaskAttemptCost({ latencyMs: 500 });
		const refolded = buildTaskAttemptCost({
			latencyMs: original.latencyMs ?? undefined,
			outputTokens: original.outputTokens ?? undefined,
		});
		expect(refolded.outputTokens).toBeNull();
		expect(refolded.unavailable.includes('outputTokens')).toBe(true);
	});
});

describe('delegation terminal producer — latency and cost joins (AC2)', () => {
	const record = {
		parentSessionId: 'parent-sess',
		swarmPrefixedAgent: 'local_coder',
		planTaskId: '2.1',
		callID: 'call-42',
		laneId: undefined,
		subagentSessionId: 'child-sess',
	};

	test('the begin producer records the attempt class with all cost axes unknown', () => {
		emitDelegationBegin({
			parentSessionId: 'begin-sess',
			swarmPrefixedAgent: 'local_coder',
			planTaskId: '3.1',
		});
		const captured = attemptEvents();
		expect(captured.length).toBe(1);
		const data = captured[0].data;
		expect(data.attemptClass).toBe('attempt');
		expect(data.taskId).toBe('3.1');
		const cost = data.cost as Record<string, unknown>;
		expect(cost.latencyMs).toBeNull();
		expect((cost.unavailable as string[]).length).toBe(6);
	});

	test('a terminal without cost evidence carries NO known token axis (never zero)', () => {
		emitDelegationEventlessTerminalEnd(record, 'stale');
		const captured = attemptEvents();
		expect(captured.length).toBe(1);
		const cost = captured[0].data.cost as Record<string, unknown>;
		expect(cost.inputTokens).toBeNull();
		expect(cost.outputTokens).toBeNull();
		expect(cost.cacheReadTokens).toBeNull();
		expect(cost.estimatedCostUsd).toBeNull();
		expect(cost.billedCostUsd).toBeNull();
		expect((cost.unavailable as string[]).includes('inputTokens')).toBe(true);
		expect(captured[0].data.callId).toBe('call-42');
		expect(captured[0].data.taskId).toBe('2.1');
	});

	test('a cancelled terminal maps to the cancelled class', () => {
		emitDelegationEventlessTerminalEnd(record, 'cancelled');
		const captured = attemptEvents();
		expect(captured.length).toBe(1);
		expect(captured[0].data.attemptClass).toBe('cancelled');
		expect(captured[0].data.outcomeStatus).toBe('unknown');
	});
});

describe('frozen cohort manifests preserve provenance (AC2)', () => {
	test('a snapshot with a directory persists a manifest with digests and a timestamp', () => {
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(directory, '.swarm', 'telemetry.jsonl'), 'x\n');
		const snap = snapshotTaskAttemptCohort({
			tasks: [{ taskId: '1.1', attemptClass: 'result' }],
			directory,
			strata: { runtime: 'bun-test' },
		});
		expect(snap.manifests.length).toBe(4);
		const event = snap.manifests.find((m) => m.source === 'event');
		expect(event?.status).toBe('captured');
		expect(typeof event?.digest).toBe('string');
		expect(event?.digest?.length).toBe(64);
		expect(typeof event?.sizeBytes).toBe('number');
		const wal = snap.manifests.find((m) => m.source === 'wal');
		expect(wal?.status).toBe('unavailable');
		const cohortDir = path.join(
			directory,
			'.swarm',
			'observability',
			'cohorts',
		);
		const files = fs.readdirSync(cohortDir).filter((f) => f.endsWith('.json'));
		expect(files.length).toBe(1);
		const persisted = JSON.parse(
			fs.readFileSync(path.join(cohortDir, files[0]), 'utf-8'),
		) as { capturedAt: string; count: number; manifests: unknown[] };
		expect(persisted.capturedAt).toBe(snap.capturedAt);
		expect(persisted.count).toBe(1);
		expect(persisted.manifests.length).toBe(4);
	});

	test('the report over the persisted snapshot is coherent', () => {
		const snap = snapshotTaskAttemptCohort({
			tasks: [
				{ taskId: '1.1', attemptClass: 'result', outcomeStatus: 'success' },
			],
			directory,
			strata: { runtime: 'bun-test' },
		});
		const report = buildTaskCohortReport(snap);
		expect(report.denominator).toBe(1);
		expect(report.qualification.reasons.join(' ')).toContain(
			'manifest_unavailable',
		);
	});
});
