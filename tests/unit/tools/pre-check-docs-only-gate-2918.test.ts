/**
 * Issue #2918 — docs-only (vacuous secretscan coverage) pre_check gate.
 *
 * A files-mode pre_check_batch whose every requested file is deliberately
 * skipped by secretscan scan policy (extension exclusion — the docs-only
 * deliverable shape) used to trip the zero-coverage fail-closed arm forever,
 * wedging docs-only tasks at update_task_status. The fix recognizes VACUOUS
 * COVERAGE — policy_skipped_files >= requested_files > 0 with zero findings
 * and zero incomplete coverage — as a pass at every enforcing site (batch
 * gate, hook decoder, check_gate_status, stage-a-repair) while keeping every
 * fail-closed floor: missing files count as incomplete 'missing', non-string
 * entries as 'invalid_entry', binary-content skips and validation-dropped
 * entries never satisfy the predicate, and legacy shapes without the new
 * fields behave exactly as before (never invalid).
 *
 * Real-tool integration (real batch + decoder + persisted evidence + real git
 * fixtures, no mock.module), mirroring diff-scope-attribution-2818.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import type { SecretscanEvidence } from '../../../src/config/evidence-schema';
import { loadEvidence } from '../../../src/evidence/manager';
import { decodePreCheckResult } from '../../../src/hooks/guardrails/pre-check-result';
import { check_gate_status } from '../../../src/tools/check-gate-status';
import { _internals as lintInternals } from '../../../src/tools/lint';
import {
	_internals as batchInternals,
	runPreCheckBatch,
} from '../../../src/tools/pre-check-batch';
import { freezeClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempProject: string | undefined;

afterEach(() => {
	if (tempProject) fs.rmSync(tempProject, { recursive: true, force: true });
	tempProject = undefined;
});

async function run(cmd: string[], cwd: string): Promise<number> {
	const proc = Bun.spawn(cmd, { cwd, stdout: 'ignore', stderr: 'ignore' });
	return proc.exited;
}

/** Real git fixture: a bare initialized project under the canonical tmpdir. */
async function newGitProject(): Promise<string> {
	const dir = canonicalMkdtemp('precheck-2918-');
	await run(['git', 'init'], dir);
	await run(['git', 'config', 'user.email', 'test@test.com'], dir);
	await run(['git', 'config', 'user.name', 'Test'], dir);
	await run(['git', 'commit', '--allow-empty', '-m', 'init'], dir);
	tempProject = dir;
	return dir;
}

function write(cwd: string, file: string, content: string | Buffer): void {
	const full = path.join(cwd, file);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content);
}

type ScanShape = {
	files_scanned: number;
	skipped_files: number;
	policy_skipped_files: number;
	requested_files: number;
	incomplete_files: number;
	incomplete_paths: Array<{ path: string; reason: string }>;
};

function scanOf(
	result: Awaited<ReturnType<typeof runPreCheckBatch>>,
): ScanShape {
	const scan = result.secretscan.result;
	if (!scan || 'error' in scan) {
		throw new Error(`secretscan error: ${String(scan?.error ?? 'no result')}`);
	}
	return scan as unknown as ScanShape;
}

async function lastSecretscanEvidence(
	dir: string,
): Promise<SecretscanEvidence> {
	const loaded = await loadEvidence(dir, 'secretscan');
	if (loaded.status !== 'found') {
		throw new Error(`secretscan evidence not found: ${loaded.status}`);
	}
	const entries = loaded.bundle.entries.filter(
		(entry): entry is SecretscanEvidence => entry.type === 'secretscan',
	);
	if (entries.length === 0) throw new Error('no secretscan evidence entries');
	return entries[entries.length - 1];
}

describe('issue #2918: docs-only pre_check batches', () => {
	test('vacuous coverage passes the gate, the decoder, and persists the counters', async () => {
		const dir = await newGitProject();
		write(dir, path.join('docs', 'notes.md'), '# Docs-only deliverable\n');
		await run(['git', 'add', '.'], dir);
		await run(['git', 'commit', '-m', 'docs-only'], dir);

		const result = await runPreCheckBatch(
			{ files: ['docs/notes.md'], directory: dir },
			dir,
			dir,
		);

		expect(result.batch_status).toBe('completed');
		expect(result.gates_passed).toBe(true);
		const scan = scanOf(result);
		expect(scan.files_scanned).toBe(0);
		expect(scan.policy_skipped_files).toBe(1);
		expect(scan.requested_files).toBe(1);
		expect(scan.incomplete_files).toBe(0);
		expect(scan.incomplete_paths).toEqual([]);

		const serialized = batchInternals.serializePreCheckResult(result);
		expect(decodePreCheckResult(serialized)).toEqual({ kind: 'pass' });

		const evidence = await lastSecretscanEvidence(dir);
		expect(evidence.verdict).toBe('pass');
		expect(evidence.summary).toContain('vacuous coverage');
		expect(evidence.policy_skipped_files).toBe(1);
		expect(evidence.requested_files).toBe(1);
	});

	test('a missing requested file stays fail-closed as incomplete (missing)', async () => {
		const dir = await newGitProject();

		const result = await runPreCheckBatch(
			{ files: ['ghost.txt'], directory: dir },
			dir,
			dir,
		);

		expect(result.gates_passed).toBe(false);
		const scan = scanOf(result);
		expect(scan.files_scanned).toBe(0);
		expect(scan.policy_skipped_files).toBe(0);
		expect(scan.incomplete_files).toBe(1);
		expect(scan.incomplete_paths).toEqual([
			{ path: 'ghost.txt', reason: 'missing' },
		]);
		const serialized = batchInternals.serializePreCheckResult(result);
		expect(decodePreCheckResult(serialized).kind).not.toBe('pass');
	});

	test('a binary-content .txt batch does NOT vacuous-pass', async () => {
		const dir = await newGitProject();
		write(dir, 'binary.txt', Buffer.alloc(64, 0));
		await run(['git', 'add', '.'], dir);
		await run(['git', 'commit', '-m', 'binary'], dir);

		const result = await runPreCheckBatch(
			{ files: ['binary.txt'], directory: dir },
			dir,
			dir,
		);

		// A .txt with embedded NULs is a scannable surface the scanner declined
		// to read — the policy counter stays 0, so the zero-coverage arm fires.
		expect(result.gates_passed).toBe(false);
		const scan = scanOf(result);
		expect(scan.files_scanned).toBe(0);
		expect(scan.skipped_files).toBe(1);
		expect(scan.policy_skipped_files).toBe(0);
		expect(scan.incomplete_files).toBe(0);
	});

	test('a mixed .ts+.md batch scans the code file and passes', async () => {
		const dir = await newGitProject();
		write(dir, 'clean.ts', 'export const answer = 42;\n');
		write(dir, path.join('docs', 'notes.md'), '# notes\n');
		await run(['git', 'add', '.'], dir);
		await run(['git', 'commit', '-m', 'mixed'], dir);

		const result = await runPreCheckBatch(
			{ files: ['clean.ts', 'docs/notes.md'], directory: dir },
			dir,
			dir,
		);

		expect(result.gates_passed).toBe(true);
		const scan = scanOf(result);
		expect(scan.files_scanned).toBe(1);
		expect(scan.policy_skipped_files).toBe(1);
		expect(scan.requested_files).toBe(2);
		expect(scan.incomplete_files).toBe(0);
	});

	test('a dropped-entry batch does not vacuous-pass and keeps the raw request basis', async () => {
		const dir = await newGitProject();
		write(dir, path.join('docs', 'notes.md'), '# notes\n');
		await run(['git', 'add', '.'], dir);
		await run(['git', 'commit', '-m', 'docs'], dir);

		// The second entry is dropped by the batch's validatePath loop BEFORE
		// the scan; requested_files must still record the RAW declared count
		// (2), so requested > policy counter keeps the batch non-vacuous.
		const result = await runPreCheckBatch(
			{ files: ['docs/notes.md', '../outside/notes.md'], directory: dir },
			dir,
			dir,
		);

		expect(result.gates_passed).toBe(false);
		const scan = scanOf(result);
		expect(scan.requested_files).toBe(2);
		expect(scan.policy_skipped_files).toBe(1);
		expect(scan.files_scanned).toBe(0);

		const evidence = await lastSecretscanEvidence(dir);
		expect(evidence.verdict).toBe('fail');
		expect(evidence.requested_files).toBe(2);
		expect(evidence.policy_skipped_files).toBe(1);

		const serialized = batchInternals.serializePreCheckResult(result);
		expect(decodePreCheckResult(serialized).kind).not.toBe('pass');
	});
});

describe('issue #2918: decoder parity for the vacuous predicate', () => {
	const toolResult = (result: Record<string, unknown>) => ({
		ran: true,
		duration_ms: 1,
		result,
	});
	const batchJson = (secretscanResult: Record<string, unknown>) =>
		JSON.stringify({
			batch_status: 'completed',
			gates_passed: true,
			lint: { ran: true, duration_ms: 1 },
			secretscan: toolResult(secretscanResult),
			sast_scan: { ran: true, duration_ms: 1, result: { verdict: 'pass' } },
			quality_budget: { ran: true, duration_ms: 1 },
			total_duration_ms: 4,
		});
	const invalid = { kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' };

	test('vacuous shape decodes as pass', () => {
		expect(
			decodePreCheckResult(
				batchJson({
					count: 0,
					findings: [],
					files_scanned: 0,
					skipped_files: 1,
					policy_skipped_files: 1,
					requested_files: 1,
					incomplete_files: 0,
					incomplete_paths: [],
				}),
			),
		).toEqual({ kind: 'pass' });
	});

	test('zero-scan without the policy counters stays a hard-gate contradiction', () => {
		expect(
			decodePreCheckResult(
				batchJson({
					count: 0,
					findings: [],
					files_scanned: 0,
					skipped_files: 1,
					incomplete_files: 0,
					incomplete_paths: [],
				}),
			),
		).toEqual(invalid);
	});

	test('legacy scanned shape without the new fields still decodes as pass (never invalid)', () => {
		expect(
			decodePreCheckResult(
				batchJson({
					count: 0,
					findings: [],
					files_scanned: 3,
					skipped_files: 0,
					incomplete_files: 0,
					incomplete_paths: [],
				}),
			),
		).toEqual({ kind: 'pass' });
	});

	test('a policy counter below the requested count is non-vacuous', () => {
		expect(
			decodePreCheckResult(
				batchJson({
					count: 0,
					findings: [],
					files_scanned: 0,
					skipped_files: 1,
					policy_skipped_files: 1,
					requested_files: 2,
					incomplete_files: 0,
					incomplete_paths: [],
				}),
			),
		).toEqual(invalid);
	});

	test('vacuous fields do not rescue findings or incomplete coverage', () => {
		for (const extra of [
			{ count: 1, findings: [{}], incomplete_files: 0, incomplete_paths: [] },
			{
				count: 0,
				findings: [],
				incomplete_files: 1,
				incomplete_paths: [{ path: 'x.txt', reason: 'missing' }],
			},
		]) {
			expect(
				decodePreCheckResult(
					batchJson({
						files_scanned: 0,
						skipped_files: 2,
						policy_skipped_files: 2,
						requested_files: 2,
						...extra,
					}),
				),
			).toEqual(invalid);
		}
	});
});

describe('issue #2918: honest biome no-files lint message', () => {
	// Stubbed execution result: a real spawn of the test runner binary that
	// reproduces biome's exact no-files failure (stderr marker + exit 1)
	// without needing a biome installation in the fixture project.
	const noFilesCommand = {
		linter: 'biome' as const,
		executable: process.execPath,
		argsPrefix: [
			'-e',
			'console.error("No files were processed in the specified paths"); process.exit(1)',
		],
		displayPrefix: [process.execPath],
		source: 'legacy-test-probe' as const,
	};

	test('runResolvedLint reports processed-no-files instead of found-issues', async () => {
		const dir = await newGitProject();
		const result = await lintInternals.runResolvedLint(
			noFilesCommand,
			'check',
			dir,
		);
		if (!result.success) throw new Error(`stub lint failed: ${result.error}`);
		expect(result.exitCode).toBe(1);
		expect(result.message).toBe(
			'biome check processed no files (all specified paths ignored by biome configuration)',
		);
	});

	test('runLintOnFiles reports the same honest message', async () => {
		const dir = await newGitProject();
		write(dir, 'notes.md', '# notes\n');
		// 'path-native' skips the legacy-test-probe delegation so the branch
		// under test is runLintOnFiles's own message construction.
		const result = await batchInternals.runLintOnFiles(
			{ ...noFilesCommand, source: 'path-native' },
			[path.join(dir, 'notes.md')],
			dir,
		);
		if (!result.success) throw new Error(`stub lint failed: ${result.error}`);
		expect(result.exitCode).toBe(1);
		expect(result.message).toBe(
			'biome check processed no files (all specified paths ignored by biome configuration)',
		);
	});
});

describe('issue #2918: check_gate_status secretscan evidence (third enforcing site)', () => {
	// Placed here rather than in check-gate-status-secretscan.test.ts: that
	// file sits at 494 of the FR-006 500-line cap and must not grow. Its
	// existing zero-coverage pins (fixtures WITHOUT the #2918 fields) stay in
	// place and green — missing fields are non-vacuous by contract.
	let restoreClock: (() => void) | undefined;
	let gateDir: string;
	let evidenceDir: string;

	function createGateEvidence(taskId: string): void {
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, `${taskId}.json`),
			JSON.stringify(
				{
					taskId,
					required_gates: ['pre_check', 'test', 'review'],
					gates: { pre_check: {}, test: {}, review: {} },
					workflow: { state: 'tests_run', generation: 1 },
				},
				null,
				2,
			),
		);
	}

	function createEvidenceBundle(
		taskId: string,
		entry: Record<string, unknown>,
	): void {
		const bundleDir = path.join(evidenceDir, taskId);
		fs.mkdirSync(bundleDir, { recursive: true });
		fs.writeFileSync(
			path.join(bundleDir, 'evidence.json'),
			JSON.stringify(
				{
					schema_version: '1.0.0',
					task_id: taskId,
					entries: [{ incomplete_files: 0, incomplete_paths: [], ...entry }],
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				},
				null,
				2,
			),
		);
	}

	async function runTool(taskId: string): Promise<Record<string, unknown>> {
		const raw = await check_gate_status.execute({ task_id: taskId }, {
			directory: gateDir,
		} as unknown as ToolContext);
		return JSON.parse(raw) as Record<string, unknown>;
	}

	beforeEach(() => {
		restoreClock = freezeClock({
			fixedNow: 1_700_000_000_000,
			isoNow: '2023-11-14T22:13:20.000Z',
		});
		gateDir = canonicalMkdtemp('check-gate-2918-');
		evidenceDir = path.join(gateDir, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDir, { recursive: true });
		tempProject = gateDir;
	});

	afterEach(() => {
		restoreClock?.();
	});

	test('vacuous evidence reports satisfied with a note instead of BLOCKED', async () => {
		createGateEvidence('1.2');
		createEvidenceBundle('1.2', {
			task_id: '1.2',
			type: 'secretscan',
			timestamp: new Date().toISOString(),
			agent: 'pre_check_batch',
			verdict: 'pass',
			summary:
				'all 1 requested file(s) skipped by secretscan scan policy (vacuous coverage)',
			findings_count: 0,
			scan_directory: 'src',
			files_scanned: 0,
			skipped_files: 1,
			policy_skipped_files: 1,
			requested_files: 1,
		});

		const result = await runTool('1.2');

		expect(result.secretscan_verdict).toBe('pass');
		expect(result.status).toBe('all_passed');
		expect(result.message).not.toContain('BLOCKED');
		expect(result.message).toContain('vacuous');
		expect(result.message).toContain('skipped by scan policy');
	});

	test('policy counter below the requested count stays BLOCKED (forger shape)', async () => {
		createGateEvidence('1.3');
		createEvidenceBundle('1.3', {
			task_id: '1.3',
			type: 'secretscan',
			timestamp: new Date().toISOString(),
			agent: 'pre_check_batch',
			verdict: 'pass',
			summary: 'Forged partial policy skip',
			findings_count: 0,
			scan_directory: 'src',
			files_scanned: 0,
			skipped_files: 1,
			policy_skipped_files: 1,
			requested_files: 2,
		});

		const result = await runTool('1.3');

		expect(result.secretscan_verdict).toBe('fail');
		expect(result.status).toBe('incomplete');
		expect(result.message).toContain('scanned zero files');
	});
});
