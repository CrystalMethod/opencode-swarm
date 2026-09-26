import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'crypto';
import * as path from 'path';
import {
	getGlobalEventBus,
	resetGlobalEventBus,
} from '../../../src/background/event-bus';
import { getSharedAutomationStatusArtifact } from '../../../src/background/status-artifact';
import {
	_internals,
	createPreflightIntegration,
} from '../../../src/services/preflight-integration';
import type { PreflightReport } from '../../../src/services/preflight-service';
import { canonicalTmpDir } from '../../helpers/tmpdir';

describe('createPreflightIntegration null-safety', () => {
	const validConfig = {
		mode: 'hybrid' as const,
		capabilities: {
			phase_preflight: true,
			plan_sync: false,
			config_doctor_on_startup: false,
			evidence_auto_summaries: false,
			decision_drift_detection: false,
		},
	};

	it('should throw descriptive error when automationConfig is null', () => {
		expect(() =>
			createPreflightIntegration({
				// @ts-expect-error - testing runtime behavior with null
				automationConfig: null,
				directory: '/test',
				swarmDir: '/test/.swarm',
			}),
		).toThrow(/Preflight is not enabled/);
	});

	it('should throw descriptive error when automationConfig is undefined', () => {
		expect(() =>
			createPreflightIntegration({
				// @ts-expect-error - testing runtime behavior with undefined
				automationConfig: undefined,
				directory: '/test',
				swarmDir: '/test/.swarm',
			}),
		).toThrow(/Preflight is not enabled/);
	});

	it('should throw descriptive error when capabilities is missing', () => {
		expect(() =>
			createPreflightIntegration({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				automationConfig: { mode: 'hybrid' } as any,
				directory: '/test',
				swarmDir: '/test/.swarm',
			}),
		).toThrow(/Preflight is not enabled/);
	});

	it('should throw descriptive error when capabilities is null', () => {
		expect(() =>
			createPreflightIntegration({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				automationConfig: { mode: 'hybrid', capabilities: null } as any,
				directory: '/test',
				swarmDir: '/test/.swarm',
			}),
		).toThrow(/Preflight is not enabled/);
	});

	it('should throw descriptive error when phase_preflight capability is false', () => {
		expect(() =>
			createPreflightIntegration({
				automationConfig: {
					mode: 'hybrid',
					capabilities: {
						phase_preflight: false,
						plan_sync: false,
						config_doctor_on_startup: false,
						evidence_auto_summaries: false,
						decision_drift_detection: false,
					},
				},
				directory: '/test',
				swarmDir: '/test/.swarm',
			}),
		).toThrow(/Preflight is not enabled/);
	});

	it('should succeed when config is valid with phase_preflight enabled', () => {
		const result = createPreflightIntegration({
			automationConfig: validConfig,
			directory: '/test',
			swarmDir: '/test/.swarm',
		});

		expect(result.manager).toBeDefined();
		expect(result.cleanup).toBeDefined();
		expect(typeof result.cleanup).toBe('function');

		// Clean up
		result.cleanup();
	});
});

describe('createPreflightIntegration automation-status detectedOnly', () => {
	const originalRunPreflight = _internals.runPreflight;

	beforeEach(() => {
		resetGlobalEventBus();
	});

	afterEach(() => {
		_internals.runPreflight = originalRunPreflight;
		mock.restore();
		resetGlobalEventBus();
	});

	function makeReport(detectedOnly: boolean): PreflightReport {
		return {
			id: 'report-1',
			timestamp: 0,
			phase: 1,
			overall: 'pass',
			checks: [
				{
					type: 'tests',
					status: 'pass',
					message: detectedOnly
						? 'Test framework detected: vitest'
						: 'Tests passed: 3 passed',
					details: detectedOnly
						? { framework: 'vitest', detectedOnly: true }
						: { framework: 'vitest' },
				},
			],
			totalDurationMs: 10,
			message: 'Preflight passed all checks',
		};
	}

	async function triggerPreflight(
		swarmDir: string,
		report: PreflightReport,
	): Promise<void> {
		_internals.runPreflight = mock(async () => report);

		const { cleanup } = createPreflightIntegration({
			automationConfig: {
				mode: 'hybrid',
				capabilities: {
					phase_preflight: true,
					plan_sync: false,
					config_doctor_on_startup: false,
					evidence_auto_summaries: false,
					decision_drift_detection: false,
				},
			},
			directory: '/test',
			swarmDir,
		});

		try {
			await getGlobalEventBus().publish('preflight.requested', {
				id: 'req-1',
				triggeredAt: 0,
				currentPhase: 1,
				source: 'manual',
				reason: 'test',
			});
		} finally {
			cleanup();
		}
	}

	it('should surface detectedOnly as a distinct skipped outcome with a tests-not-executed message', async () => {
		const swarmDir = path.join(
			canonicalTmpDir(),
			`preflight-detected-${randomUUID()}`,
		);

		await triggerPreflight(swarmDir, makeReport(true));

		const artifact = getSharedAutomationStatusArtifact(swarmDir);
		const outcome = artifact.getSnapshot().lastOutcome;

		expect(outcome?.state).toBe('skipped');
		expect(outcome?.message).toContain('tests not executed');
	});

	it('should report a normal success outcome when detectedOnly is not set', async () => {
		const swarmDir = path.join(
			canonicalTmpDir(),
			`preflight-pass-${randomUUID()}`,
		);

		await triggerPreflight(swarmDir, makeReport(false));

		const artifact = getSharedAutomationStatusArtifact(swarmDir);
		const outcome = artifact.getSnapshot().lastOutcome;

		expect(outcome?.state).toBe('success');
		expect(outcome?.message).not.toContain('tests not executed');
	});

	it('should preserve failure outcome and real failure message even when tests are detectedOnly', async () => {
		const swarmDir = path.join(
			canonicalTmpDir(),
			`preflight-fail-${randomUUID()}`,
		);
		const failureMessage = 'Preflight failed: 1 check(s) failed';

		await triggerPreflight(swarmDir, {
			id: 'report-2',
			timestamp: 0,
			phase: 1,
			overall: 'fail',
			checks: [
				{
					type: 'lint',
					status: 'fail',
					message: 'Lint found 1 issue(s)',
				},
				{
					type: 'tests',
					status: 'pass',
					message: 'Test framework detected: vitest',
					details: { framework: 'vitest', detectedOnly: true },
				},
			],
			totalDurationMs: 12,
			message: failureMessage,
		});

		const artifact = getSharedAutomationStatusArtifact(swarmDir);
		const outcome = artifact.getSnapshot().lastOutcome;

		expect(outcome?.state).toBe('failure');
		expect(outcome?.message).toBe(failureMessage);
		expect(outcome?.message).not.toContain('tests not executed');
	});
});
