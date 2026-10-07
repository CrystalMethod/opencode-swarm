/**
 * Issue #3092 — check_gate_status consumer matrix for the diff-scoped
 * secretscan evidence fields.
 *
 * The legacy fixtures (no `new_findings_count`) are pinned in
 * check-gate-status-secretscan.test.ts; this sibling suite pins the three
 * NEW states at this consumer: zero-new pass (green with visible pre-existing
 * debt), new>0 (blocked), and the failed-verdict contradiction shape
 * (complete coverage, zero new findings). Kept in a sibling file because the
 * main suite sits at the FR-006 line cap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { check_gate_status } from '../../../src/tools/check-gate-status';
import { freezeClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('check_gate_status secretscan diff-scoped evidence (#3092)', () => {
	let restoreClock: (() => void) | undefined;
	const TEST_DIR = canonicalMkdtemp('cgs-3092');
	const EVIDENCE_DIR = path.join(TEST_DIR, '.swarm', 'evidence');

	function createGateEvidence(taskId: string): void {
		fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
		fs.writeFileSync(
			path.join(EVIDENCE_DIR, `${taskId}.json`),
			JSON.stringify({
				taskId,
				required_gates: ['pre_check', 'test', 'review'],
				gates: {
					pre_check: {
						sessionId: 's',
						timestamp: '2026-10-06T00:00:00.000Z',
						agent: 'pre_check_batch',
					},
					test: {},
					review: {},
				},
				workflow: { state: 'tests_run', generation: 1 },
			}),
		);
	}

	function createEvidenceBundle(
		taskId: string,
		secretscanEntry: Record<string, unknown>,
	): void {
		const bundleDir = path.join(EVIDENCE_DIR, taskId);
		fs.mkdirSync(bundleDir, { recursive: true });
		fs.writeFileSync(
			path.join(bundleDir, 'evidence.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				task_id: taskId,
				entries: [
					{
						incomplete_files: 0,
						incomplete_paths: [],
						...secretscanEntry,
					},
				],
				created_at: '2026-10-06T00:00:00.000Z',
				updated_at: '2026-10-06T00:00:00.000Z',
			}),
		);
	}

	async function runTool(taskId: string) {
		const result = await check_gate_status.execute({ task_id: taskId }, {
			directory: TEST_DIR,
		} as unknown as ToolContext);
		return JSON.parse(result);
	}

	beforeEach(() => {
		restoreClock = freezeClock({
			fixedNow: 1_700_000_000_000,
			isoNow: '2023-11-14T22:13:20.000Z',
		});
		fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
	});

	afterEach(() => {
		restoreClock?.();
		restoreClock = undefined;
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it('zero-new pass with visible pre-existing findings stays green with an advisory', async () => {
		createGateEvidence('2.1');
		createEvidenceBundle('2.1', {
			task_id: '2.1',
			type: 'secretscan',
			timestamp: '2026-10-06T00:00:00.000Z',
			agent: 'pre_check_batch',
			verdict: 'pass',
			summary:
				'Secretscan: 1 finding(s), 1 files scanned, 0 skipped, 0 new secret finding(s) on changed lines (1 pre-existing)',
			findings_count: 1,
			new_findings_count: 0,
			preexisting_findings_count: 1,
			diff_scoped: true,
			scan_directory: 'src',
			files_scanned: 1,
			skipped_files: 0,
		});
		const result = await runTool('2.1');
		expect(result.secretscan_verdict).toBe('pass');
		expect(result.status).toBe('all_passed');
		expect(result.missing_gates).not.toContain(
			'secretscan (BLOCKED — secrets detected)',
		);
		expect(result.message).toContain('1 pre-existing secret finding(s)');
		expect(result.message).toContain('zero new secrets on changed lines');
	});

	it('new_findings_count > 0 blocks with the pinned secrets-detected literal', async () => {
		createGateEvidence('2.2');
		createEvidenceBundle('2.2', {
			task_id: '2.2',
			type: 'secretscan',
			timestamp: '2026-10-06T00:00:00.000Z',
			agent: 'pre_check_batch',
			verdict: 'fail',
			summary: 'failed',
			findings_count: 2,
			new_findings_count: 2,
			preexisting_findings_count: 0,
			diff_scoped: true,
			scan_directory: 'src',
			files_scanned: 1,
			skipped_files: 0,
		});
		const result = await runTool('2.2');
		expect(result.secretscan_verdict).toBe('fail');
		expect(result.missing_gates).toContain(
			'secretscan (BLOCKED — secrets detected)',
		);
		expect(result.message).toContain('found secrets');
		expect(result.message).toContain('2 new on changed lines');
	});

	it('failed verdict with complete coverage and zero new findings names the contradiction, not zero coverage', async () => {
		createGateEvidence('2.3');
		createEvidenceBundle('2.3', {
			task_id: '2.3',
			type: 'secretscan',
			timestamp: '2026-10-06T00:00:00.000Z',
			agent: 'pre_check_batch',
			verdict: 'fail',
			summary: 'failed: results truncated at 100 findings',
			findings_count: 100,
			new_findings_count: 0,
			preexisting_findings_count: 100,
			diff_scoped: true,
			scan_directory: 'src',
			files_scanned: 3,
			skipped_files: 0,
		});
		const result = await runTool('2.3');
		expect(result.secretscan_verdict).toBe('fail');
		expect(result.status).toBe('incomplete');
		expect(result.message).toContain('possible truncation or tampering');
		expect(result.message).not.toContain('scanned zero files');
	});

	it('legacy zero-coverage evidence keeps the verbatim scanned-zero-files wording', async () => {
		createGateEvidence('2.4');
		createEvidenceBundle('2.4', {
			task_id: '2.4',
			type: 'secretscan',
			timestamp: '2026-10-06T00:00:00.000Z',
			agent: 'pre_check_batch',
			verdict: 'pass',
			summary: 'none',
			findings_count: 0,
			scan_directory: 'src',
			files_scanned: 0,
			skipped_files: 0,
		});
		const result = await runTool('2.4');
		expect(result.secretscan_verdict).toBe('fail');
		expect(result.message).toContain('scanned zero files');
	});
});
