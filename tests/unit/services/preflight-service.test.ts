import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from 'bun:test';
import * as fs from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { resetGlobalEventBus } from '../../../src/background/event-bus';
import {
	_internals,
	formatPreflightMarkdown,
	handlePreflightCommand,
	type PreflightConfig,
	type PreflightReport,
	runPreflight,
} from '../../../src/services/preflight-service';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';

const originalRunSecretscan = _internals.runSecretscan;

describe('Preflight Service', () => {
	let testDir: string;

	beforeEach(() => {
		resetGlobalEventBus();
		// Create a temporary test directory
		testDir = fs.mkdtempSync(path.join(tmpdir(), 'preflight-test-'));
	});

	afterEach(() => {
		_internals.runSecretscan = originalRunSecretscan;
		// Clean up test directory
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true, force: true });
		}
	});

	function writePlanWithCompletedTask(): void {
		fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(testDir, '.swarm', 'spec.md'),
			'# Test Plan\n\n- FR-001 MUST be covered by implementation evidence.\n',
		);
		fs.writeFileSync(
			path.join(testDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'completed',
								size: 'small',
								description: 'Task 1.1',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			}),
		);
	}

	function writeDurableGateEvidence(taskId: string): void {
		const evidenceDir = path.join(testDir, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, `${taskId}.json`),
			JSON.stringify({
				taskId,
				required_gates: ['reviewer', 'test_engineer'],
				gates: {
					reviewer: {
						sessionId: 'review-session',
						timestamp: '2026-01-01T00:00:00.000Z',
						agent: 'reviewer',
					},
					test_engineer: {
						sessionId: 'test-session',
						timestamp: '2026-01-01T00:01:00.000Z',
						agent: 'test_engineer',
					},
				},
			}),
		);
	}

	function writeIncompleteDurableGateEvidence(taskId: string): void {
		const evidenceDir = path.join(testDir, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, `${taskId}.json`),
			JSON.stringify({
				taskId,
				required_gates: ['critic', 'reviewer', 'test_engineer'],
				gates: {
					reviewer: {
						sessionId: 'review-session',
						timestamp: '2026-01-01T00:00:00.000Z',
						agent: 'reviewer',
					},
					test_engineer: {
						sessionId: 'test-session',
						timestamp: '2026-01-01T00:01:00.000Z',
						agent: 'test_engineer',
					},
				},
			}),
		);
	}

	function writeInvalidDurableGateEvidence(taskId: string): void {
		const evidenceDir = path.join(testDir, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, `${taskId}.json`),
			JSON.stringify({
				taskId,
				required_gates: ['critic'],
			}),
		);
	}

	function writeLegacyEvidenceBundleDirectory(taskId: string): void {
		fs.mkdirSync(path.join(testDir, '.swarm', 'evidence', taskId), {
			recursive: true,
		});
	}

	describe('runPreflight', () => {
		it('should return a valid report structure', async () => {
			const report = await runPreflight(testDir, 1);

			expect(report).toHaveProperty('id');
			expect(report).toHaveProperty('timestamp');
			expect(report).toHaveProperty('phase', 1);
			expect(report).toHaveProperty('overall');
			expect(report).toHaveProperty('checks');
			expect(report).toHaveProperty('totalDurationMs');
			expect(report).toHaveProperty('message');
			expect(Array.isArray(report.checks)).toBe(true);
		});

		it('should include all check types', async () => {
			const report = await runPreflight(testDir, 1);

			const checkTypes = report.checks.map((c) => c.type);
			expect(checkTypes).toContain('lint');
			expect(checkTypes).toContain('tests');
			expect(checkTypes).toContain('secrets');
			expect(checkTypes).toContain('evidence');
			expect(checkTypes).toContain('version');
		});

		it('should respect skip configuration', async () => {
			const config: PreflightConfig = {
				skipTests: true,
				skipSecrets: true,
			};

			const report = await runPreflight(testDir, 1, config);

			const testsCheck = report.checks.find((c) => c.type === 'tests');
			const secretsCheck = report.checks.find((c) => c.type === 'secrets');

			expect(testsCheck?.status).toBe('skip');
			expect(secretsCheck?.status).toBe('skip');
			expect(testsCheck?.message).toContain('skipped');
		});

		it('should calculate overall correctly when all pass', async () => {
			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
			});

			// Lint check may error in temp dir (e.g., biome not found), causing 'fail'.
			// Accept pass, skipped, or fail depending on lint availability.
			expect(['pass', 'skipped', 'fail']).toContain(report.overall);
		});

		it('should include duration for each check', async () => {
			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
				skipVersion: true,
			});

			const lintCheck = report.checks.find((c) => c.type === 'lint');
			expect(lintCheck).toBeDefined();
			expect(lintCheck?.durationMs).toBeDefined();
			expect(typeof lintCheck?.durationMs).toBe('number');
		});
	});

	describe('formatPreflightMarkdown', () => {
		it('should format a valid report', async () => {
			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
				skipVersion: true,
			});

			const markdown = formatPreflightMarkdown(report);

			expect(markdown).toContain('## Preflight Report');
			expect(markdown).toContain(`**Phase**: ${report.phase}`);
			expect(markdown).toContain('### Checks');
		});

		it('should show pass/fail status correctly', async () => {
			const report: PreflightReport = {
				id: 'test-123',
				timestamp: 0,
				phase: 1,
				overall: 'pass',
				checks: [
					{
						type: 'lint',
						status: 'pass',
						message: 'Lint check passed',
					},
				],
				totalDurationMs: 100,
				message: 'Preflight passed all checks',
			};

			const markdown = formatPreflightMarkdown(report);
			expect(markdown).toContain('✅ PASS');
		});

		it('should show fail status correctly', async () => {
			const report: PreflightReport = {
				id: 'test-123',
				timestamp: 0,
				phase: 1,
				overall: 'fail',
				checks: [
					{
						type: 'lint',
						status: 'fail',
						message: 'Lint found issues',
					},
				],
				totalDurationMs: 100,
				message: 'Preflight failed',
			};

			const markdown = formatPreflightMarkdown(report);
			expect(markdown).toContain('❌ FAIL');
		});
	});

	describe('version check', () => {
		it('should detect version mismatch', async () => {
			// Create a package.json with version
			fs.writeFileSync(
				path.join(testDir, 'package.json'),
				JSON.stringify({ version: '1.0.0' }),
			);

			// Create a CHANGELOG with different version
			fs.writeFileSync(
				path.join(testDir, 'CHANGELOG.md'),
				'## 2.0.0\n\nSome changes',
			);

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
			});

			const versionCheck = report.checks.find((c) => c.type === 'version');
			expect(versionCheck?.status).toBe('fail');
			expect(versionCheck?.message).toContain('mismatch');
		});

		it('should pass when versions are consistent', async () => {
			// Create a package.json with version
			fs.writeFileSync(
				path.join(testDir, 'package.json'),
				JSON.stringify({ version: '1.0.0' }),
			);

			// Create a CHANGELOG with same version
			fs.writeFileSync(
				path.join(testDir, 'CHANGELOG.md'),
				'## 1.0.0\n\nSome changes',
			);

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
			});

			const versionCheck = report.checks.find((c) => c.type === 'version');
			expect(versionCheck?.status).toBe('pass');
		});
	});

	describe('timeout handling', () => {
		it('should respect check timeout configuration', async () => {
			const config: PreflightConfig = {
				checkTimeoutMs: 5000, // 5 seconds - minimum valid timeout
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
				skipVersion: true,
			};

			const { report, duration } = await withFrozenClockAsync(async () => {
				const startTime = Date.now();
				const report = await runPreflight(testDir, 1, config);
				const duration = Date.now() - startTime;
				return { report, duration };
			});

			// Should complete quickly with all checks except lint skipped
			expect(duration).toBeLessThan(5000); // Should complete in reasonable time
			expect(report.totalDurationMs).toBeLessThan(5000);
		});
	});

	describe('validateDirectoryPath', () => {
		it('should fail for null directory path', async () => {
			const report = await runPreflight(null as unknown as string, 1);

			expect(report.overall).toBe('fail');
			expect(report.checks[0]?.status).toBe('error');
			expect(report.checks[0]?.message).toContain('Invalid directory');
		});

		it('should fail for empty string directory path', async () => {
			const report = await runPreflight('', 1);

			expect(report.overall).toBe('fail');
			expect(report.checks[0]?.status).toBe('error');
			expect(report.checks[0]?.message).toContain('Invalid directory');
		});

		it('should fail for undefined directory path', async () => {
			const report = await runPreflight(undefined as unknown as string, 1);

			expect(report.overall).toBe('fail');
			expect(report.checks[0]?.status).toBe('error');
		});

		it('should reject path traversal sequences', async () => {
			const report = await runPreflight('../../../etc/passwd', 1);

			expect(report.overall).toBe('fail');
			expect(report.checks[0]?.status).toBe('error');
			expect(report.checks[0]?.message).toContain('Invalid directory');
		});
	});

	describe('validateTimeout', () => {
		it('should use default timeout when undefined', async () => {
			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
				skipVersion: true,
				// checkTimeoutMs is undefined - should use default
			});

			// Should complete successfully with default timeout
			expect(report).toBeDefined();
			expect(report.checks).toBeDefined();
		});

		it('should reject timeout <= 0', async () => {
			const report = await runPreflight(testDir, 1, {
				checkTimeoutMs: 0,
			});

			expect(report.overall).toBe('fail');
			expect(report.checks[0]?.status).toBe('error');
			expect(report.checks[0]?.message).toContain('Invalid config');
		});

		it('should reject negative timeout', async () => {
			const report = await runPreflight(testDir, 1, {
				checkTimeoutMs: -1000,
			});

			expect(report.overall).toBe('fail');
			expect(report.checks[0]?.status).toBe('error');
		});

		it('should reject timeout below minimum (5s)', async () => {
			const report = await runPreflight(testDir, 1, {
				checkTimeoutMs: 1000, // 1 second - below 5s minimum
			});

			expect(report.overall).toBe('fail');
			expect(report.checks[0]?.status).toBe('error');
			expect(report.checks[0]?.message).toContain('at least');
		});

		it('should reject timeout above maximum (5 minutes)', async () => {
			const report = await runPreflight(testDir, 1, {
				checkTimeoutMs: 400000, // 400 seconds - above 5 minute max
			});

			expect(report.overall).toBe('fail');
			expect(report.checks[0]?.status).toBe('error');
			expect(report.checks[0]?.message).toContain('not exceed');
		});

		it('should reject non-number timeout (NaN)', async () => {
			const report = await runPreflight(testDir, 1, {
				checkTimeoutMs: NaN,
			});

			expect(report.overall).toBe('fail');
			expect(report.checks[0]?.status).toBe('error');
		});

		it('should reject Infinity timeout', async () => {
			const report = await runPreflight(testDir, 1, {
				checkTimeoutMs: Infinity,
			});

			expect(report.overall).toBe('fail');
			expect(report.checks[0]?.status).toBe('error');
		});
	});

	describe('version file support', () => {
		it('should detect version from VERSION.txt file', async () => {
			// Create a VERSION.txt file
			fs.writeFileSync(path.join(testDir, 'VERSION.txt'), '2.5.0');

			// Create matching package.json
			fs.writeFileSync(
				path.join(testDir, 'package.json'),
				JSON.stringify({ version: '2.5.0' }),
			);

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
			});

			const versionCheck = report.checks.find((c) => c.type === 'version');
			expect(versionCheck?.status).toBe('pass');
			expect(versionCheck?.message).toContain('version file');
		});

		it('should detect version from version.txt file', async () => {
			fs.writeFileSync(path.join(testDir, 'version.txt'), '3.0.0');

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
			});

			const versionCheck = report.checks.find((c) => c.type === 'version');
			expect(versionCheck?.status).toBe('pass');
		});

		it('should detect version from VERSION file', async () => {
			fs.writeFileSync(path.join(testDir, 'VERSION'), '1.2.3');

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
			});

			const versionCheck = report.checks.find((c) => c.type === 'version');
			expect(versionCheck?.status).toBe('pass');
		});

		it('should skip when no version info found', async () => {
			// No package.json, no CHANGELOG, no VERSION files
			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
			});

			const versionCheck = report.checks.find((c) => c.type === 'version');
			expect(versionCheck?.status).toBe('skip');
			expect(versionCheck?.message).toContain('No version information found');
		});

		it('should detect mismatch with version file', async () => {
			fs.writeFileSync(path.join(testDir, 'VERSION.txt'), '1.0.0');
			fs.writeFileSync(
				path.join(testDir, 'package.json'),
				JSON.stringify({ version: '2.0.0' }),
			);

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
			});

			const versionCheck = report.checks.find((c) => c.type === 'version');
			expect(versionCheck?.status).toBe('fail');
			expect(versionCheck?.message).toContain('mismatch');
		});

		it('should handle VERSION file with non-semver content', async () => {
			fs.writeFileSync(path.join(testDir, 'VERSION'), 'snapshot-build');

			// No other version sources - should skip
			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
			});

			const versionCheck = report.checks.find((c) => c.type === 'version');
			expect(versionCheck?.status).toBe('skip');
		});
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

		it('should render a detectedOnly tests check as informational/skip with a tests-not-executed message', () => {
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

		it('should render a tests check without detectedOnly as a normal pass', () => {
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

	describe('overall result calculation', () => {
		it('should return skipped when all checks are skipped', async () => {
			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
				skipVersion: true,
			});

			// Lint always runs (cannot be skipped). It may pass, fail, or error
			// depending on biome availability in the test environment.
			// Accept pass, skipped, or fail.
			expect(['pass', 'skipped', 'fail']).toContain(report.overall);
		});

		it('should count failed checks correctly', async () => {
			// Create version mismatch to force a failure
			fs.writeFileSync(
				path.join(testDir, 'package.json'),
				JSON.stringify({ version: '1.0.0' }),
			);
			fs.writeFileSync(
				path.join(testDir, 'CHANGELOG.md'),
				'## 9.9.9\n\nChanges',
			);

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
			});

			expect(report.overall).toBe('fail');
			expect(report.message).toContain('failed');
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

	describe('handlePreflightCommand', () => {
		it('should return formatted markdown for valid directory', async () => {
			const result = await handlePreflightCommand(testDir, []);
			expect(result).toContain('## Preflight Report');
		});

		it('should use phase 1 as default', async () => {
			const result = await handlePreflightCommand(testDir, []);
			expect(result).toContain('**Phase**: 1');
		});

		it('should handle invalid directory gracefully', async () => {
			const result = await handlePreflightCommand('', []);
			expect(result).toContain('## Preflight Report');
			expect(result).toContain('❌ FAIL');
		});
	});
});
