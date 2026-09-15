import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { handleReportCommand } from '../../../src/commands/report.js';
import { appendObservabilityEventDb } from '../../../src/db/observability-event-store.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { createObservation } from '../../../src/observability/index.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function makeProject(): string {
	const dir = canonicalMkdtemp('swarm-report-cohort-');
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	return dir;
}

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) {
		const d = dirs.pop()!;
		closeAllProjectDbs();
		rmSync(d, { recursive: true, force: true });
	}
});

function seedAttempt(dir: string, payload: Record<string, unknown>): void {
	appendObservabilityEventDb(
		dir,
		createObservation('execution_attempt_recorded', {
			sessionId: 'sess-1',
			...payload,
		}) as ReturnType<typeof createObservation>,
	);
}

describe('/swarm report — task attempts cohort section (issue #2676 integration)', () => {
	test('folds attempt rows into the cohort: class counts, cost split, uncertainty, qualification', async () => {
		const dir = makeProject();
		dirs.push(dir);
		seedAttempt(dir, {
			taskId: '1.1',
			callId: 'call-1',
			attemptClass: 'result',
			outcomeStatus: 'success',
			cost: {
				latencyMs: 1200,
				inputTokens: 100,
				outputTokens: 40,
				cacheReadTokens: 0,
				estimatedCostUsd: null,
				billedCostUsd: 0.02,
				unavailable: ['estimatedCostUsd'],
			},
		});
		seedAttempt(dir, {
			taskId: '1.2',
			callId: 'call-2',
			attemptClass: 'denial',
			outcomeStatus: 'unknown',
		});
		seedAttempt(dir, {
			taskId: '1.1',
			callId: 'call-3',
			attemptClass: 'late',
			generation: 4,
			outcomeStatus: 'unknown',
		});

		const json = await handleReportCommand(dir, ['--json']);
		const match = json.match(/\[REPORT_JSON\](.*)\[\/REPORT_JSON\]/);
		expect(match).not.toBeNull();
		const parsed = JSON.parse(match![1]) as {
			schemaVersion: number;
			taskAttempts: {
				denominator: number;
				perClassCounts: Record<string, number>;
				costTotalsKnown: Record<string, number>;
				costUnavailableCounts: Record<string, number>;
				uncertainty: string[];
				qualification: { qualified: boolean; reasons: string[] };
			};
		};
		expect(parsed.schemaVersion).toBe(2);
		const cohort = parsed.taskAttempts;
		expect(cohort.denominator).toBe(3);
		expect(cohort.perClassCounts.result).toBe(1);
		expect(cohort.perClassCounts.denial).toBe(1);
		expect(cohort.perClassCounts.late).toBe(1);
		// Known axes summed only over records that held them.
		expect(cohort.costTotalsKnown.latencyMs).toBe(1200);
		expect(cohort.costTotalsKnown.billedCostUsd).toBeCloseTo(0.02);
		// The two records with no cost block count as unavailable per axis.
		expect(cohort.costUnavailableCounts.latencyMs).toBe(2);
		expect(cohort.costUnavailableCounts.billedCostUsd).toBe(2);
		// Uncertainty is present (small sample, unavailable cost axes, unknown
		// outcomes) and the cohort is explicitly unqualified.
		expect(cohort.uncertainty.length).toBeGreaterThan(0);
		expect(cohort.qualification.qualified).toBe(false);
		expect(
			cohort.qualification.reasons.some((r) =>
				r.startsWith('manifest_unavailable:'),
			),
		).toBe(true);
	});

	test('markdown report renders the cohort section with the qualification line', async () => {
		const dir = makeProject();
		dirs.push(dir);
		seedAttempt(dir, {
			taskId: '2.1',
			callId: 'call-9',
			attemptClass: 'result',
			outcomeStatus: 'success',
		});
		const md = await handleReportCommand(dir, []);
		expect(md).toContain('**Task attempts (cohort)**');
		expect(md).toContain('denominator 1');
		expect(md).toContain('result=1');
		expect(md).toContain('Causal-rate qualification: UNQUALIFIED');
		expect(md).toContain('Uncertainty:');
	});

	test('a report with no attempt rows renders an explicit empty cohort', async () => {
		const dir = makeProject();
		dirs.push(dir);
		// The store must exist (any non-attempt event creates it) while the
		// attempt population stays empty.
		appendObservabilityEventDb(
			dir,
			createObservation('gate_passed', {
				sessionId: 'sess-1',
				gate: 'pre_check',
				taskId: 't0',
			}) as ReturnType<typeof createObservation>,
		);
		const md = await handleReportCommand(dir, []);
		expect(md).toContain('**Task attempts (cohort)**');
		expect(md).toContain('denominator 0');
		expect(md).toContain('classes: none recorded');
	});
});
