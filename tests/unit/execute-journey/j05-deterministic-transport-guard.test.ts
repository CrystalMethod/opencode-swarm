/**
 * j05 — deterministic transport + no-process-exit-only proof (AC5, issue
 * #2666). Positive: a journey leg runs entirely on the pinned scripted
 * client (every host call recorded through the seam; no live model, no
 * network). Negative controls: the journey validator REJECTS a stage whose
 * only representation is stdout + process exit, flags unevidenced stages,
 * and the canary-evidence validator REJECTS a deterministic report — so the
 * artifact assertions are load-bearing, not vacuous.
 */
import { describe, expect, test } from 'bun:test';
import {
	JOURNEY_REPORT_SCHEMA_VERSION,
	JourneyDriver,
	type JourneyReport,
	ScriptedHostClient,
	validateCanaryEvidence,
	validateJourneyReport,
} from '../../helpers/execute-journey-driver';

function reportWith(
	stages: JourneyReport['stages'],
	overrides: Partial<JourneyReport> = {},
): JourneyReport {
	return {
		schemaVersion: JOURNEY_REPORT_SCHEMA_VERSION,
		fixture_class: 'deterministic',
		command: 'bun test j05 synthetic reports',
		runtime: {
			bun: String(process.versions.bun ?? 'n/a'),
			node: String(process.versions.node ?? 'n/a'),
		},
		host: {
			platform: process.platform,
			arch: process.arch,
			pluginVersion: 'test',
		},
		startedAt: '2026-01-01T00:00:00.000Z',
		endedAt: '2026-01-01T00:00:01.000Z',
		stages,
		planBinding: { planId: 'p1', approvedPayloadHash: 'h1' },
		executedCells: ['bun/win32'],
		labeledUnexecutedCells: ['node/full-journey'],
		transport: 'scripted-client',
		...overrides,
	};
}

describe('journey validator — no stdout-only completion proof (#2666)', () => {
	test('a fully evidenced journey report validates', () => {
		const report = reportWith([
			{
				name: 'execute',
				startStatus: 'idle',
				endStatus: 'coder_delegated',
				evidence: {
					durableArtifacts: ['.swarm/evidence/1.1.json'],
					toolCallIds: ['c1'],
					resultIds: ['r1'],
				},
			},
		]);
		const verdict = validateJourneyReport(report);
		expect(verdict.valid).toBe(true);
		expect(verdict.reasons).toEqual([]);
		expect(verdict.unevidencedStages).toEqual([]);
	});

	test('a stage represented ONLY by stdout + process exit REJECTS the report', () => {
		const report = reportWith([
			{
				name: 'pre-check',
				startStatus: 'coder_delegated',
				endStatus: 'exited-0',
				evidence: {
					durableArtifacts: [],
					toolCallIds: [],
					resultIds: [],
					stdoutOnly: true,
				},
			},
		]);
		const verdict = validateJourneyReport(report);
		expect(verdict.valid).toBe(false);
		expect(verdict.unevidencedStages).toEqual(['pre-check']);
		expect(verdict.reasons).toContain(
			'unevidenced-stage:pre-check (stdout/process-exit only)',
		);
	});

	test('a stage with empty evidence arrays is flagged unevidenced (vacuity guard)', () => {
		const report = reportWith([
			{
				name: 'reviewer',
				startStatus: 'pre_check_passed',
				endStatus: 'reviewer_run',
				evidence: { durableArtifacts: [], toolCallIds: [], resultIds: [] },
			},
		]);
		const verdict = validateJourneyReport(report);
		expect(verdict.valid).toBe(false);
		expect(verdict.unevidencedStages).toEqual(['reviewer']);
	});

	test('a completed journey without the approved-plan binding is rejected', () => {
		const report = reportWith(
			[
				{
					name: 'finish',
					startStatus: 'tests_run',
					endStatus: 'task_completed',
					evidence: {
						durableArtifacts: ['.swarm/evidence/1.1.json'],
						toolCallIds: ['c1'],
						resultIds: ['r1'],
					},
				},
			],
			{ planBinding: null },
		);
		const verdict = validateJourneyReport(report);
		expect(verdict.valid).toBe(false);
		expect(verdict.reasons).toContain('missing-plan-binding');
	});

	test('an empty report is rejected', () => {
		const verdict = validateJourneyReport(reportWith([]));
		expect(verdict.valid).toBe(false);
		expect(verdict.reasons).toContain('no-stages-recorded');
	});
});

describe('canary evidence separation — a mock can never masquerade as model quality (#2666)', () => {
	test('a deterministic report is REJECTED as canary evidence', () => {
		const deterministic = reportWith([
			{
				name: 'execute',
				startStatus: 'idle',
				endStatus: 'coder_delegated',
				evidence: {
					durableArtifacts: ['.swarm/evidence/1.1.json'],
					toolCallIds: ['c1'],
					resultIds: ['r1'],
				},
			},
		]);
		const verdict = validateCanaryEvidence(deterministic);
		expect(verdict.valid).toBe(false);
		expect(verdict.reasons).toContain(
			'deterministic-report-is-not-canary-evidence',
		);
	});

	test('only a live-model model-canary report satisfies canary evidence', () => {
		const canary = reportWith(
			[
				{
					name: 'execute',
					startStatus: 'idle',
					endStatus: 'coder_delegated',
					evidence: {
						durableArtifacts: ['.swarm/evidence/1.1.json'],
						toolCallIds: ['c1'],
						resultIds: ['r1'],
					},
				},
			],
			{ fixture_class: 'model-canary', transport: 'live-model' },
		);
		expect(validateCanaryEvidence(canary).valid).toBe(true);
		// A scripted transport wearing the canary label still fails.
		const fakeCanary = reportWith(
			[
				{
					name: 'execute',
					startStatus: 'idle',
					endStatus: 'coder_delegated',
					evidence: {
						durableArtifacts: ['.swarm/evidence/1.1.json'],
						toolCallIds: ['c1'],
						resultIds: ['r1'],
					},
				},
			],
			{ fixture_class: 'model-canary', transport: 'scripted-client' },
		);
		const verdict = validateCanaryEvidence(fakeCanary);
		expect(verdict.valid).toBe(false);
		expect(verdict.reasons).toContain(
			'canary-evidence-requires-live-model-transport',
		);
	});
});

describe('deterministic transport seam — every host call is recorded (#2666)', () => {
	test('a real journey leg reaches the host boundary only through the scripted client', async () => {
		const { createIsolatedTestEnv } = await import(
			'../../helpers/isolated-test-env'
		);
		const { resetSwarmState } = await import('../../../src/state');
		const { bootJourneyHost, createJourneyProject, parseToolResult } =
			await import('../../helpers/execute-journey-driver');
		const cleanupEnv = createIsolatedTestEnv().cleanup;
		resetSwarmState();
		const project = createJourneyProject('swarm-j05-');
		try {
			const booted = await bootJourneyHost({ directory: project.directory });
			const driver = new JourneyDriver(booted);
			await driver.configure();
			const dispatch = parseToolResult(
				await booted.host.tool.dispatch_lanes_async.execute(
					{
						batch_id: 'journey-transport-seam',
						mode: 'journey-transport-probe',
						max_concurrent: 1,
						lanes: [
							{
								id: 'seam-1',
								agent: 'explorer',
								prompt: 'Deterministic transport probe.',
							},
						],
					},
					{ directory: project.directory, sessionID: driver.sessionID },
				),
			);
			expect(dispatch.success).toBe(true);
			// The recording seam observed the transport: every host call
			// the leg made went through the scripted client (no live
			// provider is configured anywhere in the fixture).
			const surfaces = booted.client.calls.map((call) => call.surface);
			expect(surfaces).toContain('session.create');
			expect(surfaces).toContain('session.promptAsync');
			expect(surfaces.every((s) => s.startsWith('session.'))).toBe(true);
			const report = driver.report({ command: 'bun test j05 transport seam' });
			expect(report.transport).toBe('scripted-client');
			expect(report.fixture_class).toBe('deterministic');
		} finally {
			resetSwarmState();
			project.cleanup();
			cleanupEnv();
		}
	}, 120_000);
});
