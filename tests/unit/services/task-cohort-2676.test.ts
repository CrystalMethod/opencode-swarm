import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildTaskCohortReport,
	COHORT_MANIFEST_RETENTION,
	COHORT_SAMPLE_SIZE_THRESHOLD,
	snapshotTaskAttemptCohort,
} from '../../../src/services/task-cohort';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('snapshotTaskAttemptCohort — stable cohort capture (AC3)', () => {
	let directory = '';

	test('post-snapshot mutation of the live population cannot change the snapshot', () => {
		const live = [
			{ taskId: 'task-1', attemptClass: 'result', outcomeStatus: 'success' },
			{ taskId: 'task-2', attemptClass: 'denial' },
		];
		const snap = snapshotTaskAttemptCohort({ tasks: live });
		live.push({ taskId: 'task-3' });
		live[0].attemptClass = 'mutated';
		expect(snap.tasks.length).toBe(2);
		expect(snap.count).toBe(2);
		expect(snap.tasks[0].attemptClass).toBe('result');
		expect(typeof snap.capturedAt).toBe('string');
		expect(snap.capturedAt.length).toBeGreaterThan(0);
	});

	test('deep mutation of a nested field does not leak into the snapshot', () => {
		const live = [
			{
				taskId: 'task-1',
				cost: { latencyMs: 100, unavailable: [] as string[] },
			},
		];
		const snap = snapshotTaskAttemptCohort({ tasks: live });
		live[0].cost.latencyMs = 9999;
		const snapCost = snap.tasks[0].cost as { latencyMs: number };
		expect(snapCost.latencyMs).toBe(100);
	});

	test('the report denominator is the captured size, never a live recount', () => {
		const live = [{ taskId: 'task-1' }, { taskId: 'task-2' }];
		const snap = snapshotTaskAttemptCohort({ tasks: live });
		live.push({ taskId: 'task-3' }, { taskId: 'task-4' });
		const report = buildTaskCohortReport(snap);
		expect(report.denominator).toBe(2);
	});

	test('the manifest set is complete and missing sources are explicit', () => {
		directory = canonicalMkdtemp('task-cohort-2676-');
		try {
			fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
			fs.writeFileSync(path.join(directory, '.swarm', 'events.jsonl'), 'a\n');
			const snap = snapshotTaskAttemptCohort({ tasks: [], directory });
			const sources = snap.manifests.map((m) => m.source).sort();
			expect(sources).toEqual(['event', 'host_status', 'trigger', 'wal']);
			const bySource = new Map(snap.manifests.map((m) => [m.source, m]));
			expect(bySource.get('trigger')?.status).toBe('captured');
			expect(bySource.get('wal')?.status).toBe('unavailable');
			expect(bySource.get('wal')?.digest).toBeUndefined();
			expect(bySource.get('host_status')?.status).toBe('captured');
		} finally {
			safeRmRecursive(directory);
		}
	});

	test('manifest FIFO retention keeps the latest bounded set', () => {
		directory = canonicalMkdtemp('task-cohort-fifo-2676-');
		try {
			const cohorts = path.join(
				directory,
				'.swarm',
				'observability',
				'cohorts',
			);
			fs.mkdirSync(cohorts, { recursive: true });
			for (let i = 0; i < COHORT_MANIFEST_RETENTION + 5; i++) {
				snapshotTaskAttemptCohort({
					tasks: [{ taskId: `t-${i}` }],
					directory,
					now: new Date(1_700_000_000_000 + i * 1000),
				});
			}
			const files = fs.readdirSync(cohorts).filter((f) => f.endsWith('.json'));
			expect(files.length).toBe(COHORT_MANIFEST_RETENTION);
			// The survivors must be the NEWEST 20: evicted are exactly the 5
			// oldest stamps, retained are stamps 5..24.
			const stamps = files
				.map((f) => Number.parseInt(f.split('-')[0], 10))
				.sort((a, b) => a - b);
			expect(stamps[0]).toBe(1_700_000_000_000 + 5 * 1000);
			expect(stamps[stamps.length - 1]).toBe(
				1_700_000_000_000 + (COHORT_MANIFEST_RETENTION + 4) * 1000,
			);
			expect(stamps).not.toContain(1_700_000_000_000);
		} finally {
			safeRmRecursive(directory);
		}
	});
});

describe('buildTaskCohortReport — uncertainty and qualification (AC3)', () => {
	test('incomplete per-task data yields a non-empty uncertainty channel', () => {
		const snap = snapshotTaskAttemptCohort({
			tasks: [{ taskId: 'task-1' }, { taskId: 'task-2' }],
		});
		const report = buildTaskCohortReport(snap);
		expect(report.uncertainty.length).toBeGreaterThan(0);
		const joined = report.uncertainty.join(';');
		expect(joined).toContain('sample_size_below_threshold');
		expect(joined).toContain('cost_axis_unavailable');
		expect(joined).toContain('outcome_unknown');
	});

	test('an empty population is explicitly unqualified with a reason', () => {
		const snap = snapshotTaskAttemptCohort({ tasks: [] });
		const report = buildTaskCohortReport(snap);
		expect(report.denominator).toBe(0);
		expect(report.uncertainty.length).toBeGreaterThan(0);
		expect(report.qualification.qualified).toBe(false);
		expect(report.qualification.reasons).toContain('no_population');
	});

	test('missing strata is an enumerated unqualification reason', () => {
		const tasks = Array.from(
			{ length: COHORT_SAMPLE_SIZE_THRESHOLD },
			(_, i) => ({
				taskId: `t-${i}`,
				attemptClass: 'result',
				outcomeStatus: 'success',
				cost: {
					latencyMs: 10,
					inputTokens: 1,
					outputTokens: 1,
					cacheReadTokens: 0,
					estimatedCostUsd: 0.001,
					billedCostUsd: null,
					unavailable: ['billedCostUsd'],
				},
			}),
		);
		const snap = snapshotTaskAttemptCohort({ tasks });
		const report = buildTaskCohortReport(snap);
		expect(report.qualification.qualified).toBe(false);
		expect(report.qualification.reasons).toContain('missing_strata');
	});

	test('per-class counts and known-cost totals aggregate only held axes', () => {
		const snap = snapshotTaskAttemptCohort({
			tasks: [
				{
					taskId: 'a',
					attemptClass: 'result',
					outcomeStatus: 'success',
					cost: { latencyMs: 100, unavailable: ['inputTokens'] },
				},
				{
					taskId: 'b',
					attemptClass: 'denial',
					cost: { latencyMs: 50, inputTokens: 7, unavailable: [] },
				},
			],
		});
		const report = buildTaskCohortReport(snap);
		expect(report.perClassCounts.result).toBe(1);
		expect(report.perClassCounts.denial).toBe(1);
		expect(report.costTotalsKnown.latencyMs).toBe(150);
		expect(report.costTotalsKnown.inputTokens).toBe(7);
		expect(report.costUnavailableCounts.inputTokens).toBe(1);
		expect(report.costUnavailableCounts.latencyMs).toBe(0);
	});
});
