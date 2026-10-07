import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { resetGlobalEventBus } from '../../../src/background/event-bus';
import {
	_internals,
	formatPreflightMarkdown,
	type PreflightReport,
	runPreflight,
} from '../../../src/services/preflight-service';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('Preflight Service (detected-only)', () => {
	let testDir: string;

	beforeEach(() => {
		resetGlobalEventBus();
		// Create a temporary test directory
		testDir = canonicalMkdtemp('preflight-test-');
	});

	afterEach(() => {
		// Clean up test directory
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe('formatPreflightMarkdown edge cases', () => {
		it('should format error status with warning icon', () => {
			const report: PreflightReport = {
				id: 'test-err',
				timestamp: 0,
				phase: 1,
				overall: 'fail',
				checks: [
					{
						type: 'lint',
						status: 'error',
						message: 'Lint check crashed',
					},
				],
				totalDurationMs: 100,
				message: 'Preflight encountered errors',
			};

			const markdown = formatPreflightMarkdown(report);
			expect(markdown).toContain('⚠️');
			expect(markdown).toContain('error');
		});

		it('should format skip status with skip icon', () => {
			const report: PreflightReport = {
				id: 'test-skip',
				timestamp: 0,
				phase: 1,
				overall: 'skipped',
				checks: [
					{
						type: 'tests',
						status: 'skip',
						message: 'Tests skipped by config',
					},
				],
				totalDurationMs: 10,
				message: 'All checks were skipped',
			};

			const markdown = formatPreflightMarkdown(report);
			expect(markdown).toContain('⏭️');
			expect(markdown).toContain('SKIPPED');
		});

		it('should handle mixed status checks', () => {
			const report: PreflightReport = {
				id: 'test-mixed',
				timestamp: 0,
				phase: 2,
				overall: 'fail',
				checks: [
					{ type: 'lint', status: 'pass', message: 'OK' },
					{ type: 'tests', status: 'fail', message: 'Failed' },
					{ type: 'secrets', status: 'skip', message: 'Skipped' },
					{ type: 'evidence', status: 'error', message: 'Error' },
				],
				totalDurationMs: 500,
				message: 'Mixed results',
			};

			const markdown = formatPreflightMarkdown(report);
			expect(markdown).toContain('✅');
			expect(markdown).toContain('❌');
			expect(markdown).toContain('⏭️');
			expect(markdown).toContain('⚠️');
		});

		it('should format overall skipped status correctly', () => {
			const report: PreflightReport = {
				id: 'test-overall-skip',
				timestamp: 0,
				phase: 3,
				overall: 'skipped',
				checks: [{ type: 'lint', status: 'skip', message: 'Skipped' }],
				totalDurationMs: 5,
				message: 'All checks were skipped',
			};

			const markdown = formatPreflightMarkdown(report);
			expect(markdown).toContain('**Overall**: ⏭️ SKIPPED');
		});

		it('should render a detectedOnly tests check as informational/skip with a tests-not-executed message', async () => {
			await withFrozenClockAsync(async () => {
				const report: PreflightReport = {
					id: 'test-detected-only',
					timestamp: Date.now(),
					phase: 1,
					overall: 'pass',
					checks: [
						{
							type: 'tests',
							status: 'pass',
							message: 'Test framework detected: vitest',
							details: { framework: 'vitest', detectedOnly: true },
						},
					],
					totalDurationMs: 10,
					message: 'Preflight passed all checks',
				};

				const markdown = formatPreflightMarkdown(report);

				// The detectedOnly flag must surface as a distinct informational/skip
				// rendering with an explicit "tests not executed" message, not as a
				// plain pass indistinguishable from a real test run.
				expect(markdown).toContain('⏭️');
				expect(markdown).toContain('detected only — tests not executed');
				expect(markdown).not.toContain('Test framework detected: vitest');
			});
		});

		it('should render a tests check without detectedOnly as a normal pass', async () => {
			await withFrozenClockAsync(async () => {
				const report: PreflightReport = {
					id: 'test-real-pass',
					timestamp: Date.now(),
					phase: 1,
					overall: 'pass',
					checks: [
						{
							type: 'tests',
							status: 'pass',
							message: 'Tests passed: 3 passed',
							details: { framework: 'vitest' },
						},
					],
					totalDurationMs: 10,
					message: 'Preflight passed all checks',
				};

				const markdown = formatPreflightMarkdown(report);

				expect(markdown).toContain('✅');
				expect(markdown).toContain('Tests passed: 3 passed');
				expect(markdown).not.toContain('tests not executed');
			});
		});
	});

	describe('tests check framework detection', () => {
		it('should report the detected framework when a supported project structure is present', async () => {
			// A package.json with a scripts.test is detected from file presence
			// alone by the language-backend dispatch layer — no real test runner
			// toolchain is required on PATH, and no test suite is executed.
			fs.writeFileSync(
				path.join(testDir, 'package.json'),
				JSON.stringify({ scripts: { test: 'vitest run' } }),
			);

			const result = await _internals.runTestsCheck(
				testDir,
				'convention',
				60000,
			);

			expect(result.type).toBe('tests');
			expect(result.status).toBe('pass');
			expect(result.details?.framework).toBe('vitest');
			expect(result.details?.detectedOnly).toBe(true);
			expect(result.message).toContain('Test framework detected');
		});

		it('should preserve original behavior when no framework is detected', async () => {
			// Empty temp dir — no manifest, so dispatch detection returns 'none'
			// and the legacy runTests('none', ...) path runs unchanged, surfacing
			// the original error result.
			const result = await _internals.runTestsCheck(
				testDir,
				'convention',
				60000,
			);

			expect(result.type).toBe('tests');
			expect(result.status).toBe('error');
			expect(result.details?.framework).toBe('none');
			expect(result.details?.detectedOnly).toBeUndefined();
		});

		it('should qualify pass messaging when tests are detectedOnly and render overall as partial', async () => {
			const originalRunLintCheck = _internals.runLintCheck;
			const originalRunTestsCheck = _internals.runTestsCheck;
			const originalRunSecretsCheck = _internals.runSecretsCheck;
			const originalRunEvidenceCheck = _internals.runEvidenceCheck;
			const originalRunRequirementCoverageCheck =
				_internals.runRequirementCoverageCheck;
			const originalRunVersionCheck = _internals.runVersionCheck;

			_internals.runLintCheck = mock(async () => ({
				type: 'lint',
				status: 'pass',
				message: 'Lint check passed',
				durationMs: 1,
			}));
			_internals.runTestsCheck = mock(async () => ({
				type: 'tests',
				status: 'pass',
				message: 'Test framework detected: vitest',
				details: { framework: 'vitest', detectedOnly: true },
				durationMs: 1,
			}));
			_internals.runSecretsCheck = mock(async () => ({
				type: 'secrets',
				status: 'pass',
				message: 'No secrets detected',
				durationMs: 1,
			}));
			_internals.runEvidenceCheck = mock(async () => ({
				type: 'evidence',
				status: 'pass',
				message: 'All completed tasks have evidence',
				durationMs: 1,
			}));
			_internals.runRequirementCoverageCheck = mock(async () => ({
				type: 'req_coverage',
				status: 'pass',
				message: 'Requirement coverage report found',
				durationMs: 1,
			}));
			_internals.runVersionCheck = mock(async () => ({
				type: 'version',
				status: 'pass',
				message: 'Version consistent',
				durationMs: 1,
			}));

			try {
				const report = await runPreflight(testDir, 1);
				expect(report.overall).toBe('pass');
				expect(report.message).toBe(
					'Preflight passed all checks except tests (detected only — not executed)',
				);

				const markdown = formatPreflightMarkdown(report);
				expect(markdown).toContain('PARTIAL (tests detected only)');
				expect(markdown).not.toContain('**Overall**: ✅ PASS');
			} finally {
				_internals.runLintCheck = originalRunLintCheck;
				_internals.runTestsCheck = originalRunTestsCheck;
				_internals.runSecretsCheck = originalRunSecretsCheck;
				_internals.runEvidenceCheck = originalRunEvidenceCheck;
				_internals.runRequirementCoverageCheck =
					originalRunRequirementCoverageCheck;
				_internals.runVersionCheck = originalRunVersionCheck;
			}
		});
	});
});
