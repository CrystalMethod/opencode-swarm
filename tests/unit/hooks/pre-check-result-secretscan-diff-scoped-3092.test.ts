/**
 * Issue #3092 — hook-decoder diff-scope proof (decodePreCheckResult /
 * isToolResultBlocking secretscan arm).
 *
 * Pins that the batch-carried `secretscan_preexisting_findings` proof
 * disarms ONLY the findings-count conditions: truncation, a total-set
 * mismatch, incomplete coverage, and zero-coverage keep blocking regardless
 * of proof, and a forged `passed` without proof still blocks.
 */
import { describe, expect, test } from 'bun:test';
import { decodePreCheckResult } from '../../../src/hooks/guardrails/pre-check-result';

function secretFinding(path = 'C:/x/legacy.txt', line = 1) {
	return {
		path,
		line,
		type: 'aws_access_key',
		confidence: 'high',
		severity: 'critical',
		redacted: 'AKIA[REDACTED]',
		context: 'redacted',
	};
}

function batchJson(
	secretscanOverrides: Record<string, unknown>,
	batchOverrides: Record<string, unknown> = {},
): string {
	const finding = secretFinding();
	const secretscan = {
		ran: true,
		duration_ms: 1,
		result: {
			scan_dir: 'C:/x',
			findings: [finding],
			count: 1,
			files_scanned: 1,
			skipped_files: 0,
			policy_skipped_files: 0,
			requested_files: 1,
			ignored_files: 0,
			incomplete_files: 0,
			incomplete_paths: [],
			...secretscanOverrides,
		},
	};
	return JSON.stringify({
		batch_status: 'completed',
		gates_passed: true,
		lint: { ran: false, duration_ms: 0, error: 'x' },
		secretscan,
		sast_scan: { ran: false, duration_ms: 0 },
		sast_skipped: true,
		quality_budget: { ran: false, duration_ms: 0, error: 'x' },
		total_duration_ms: 1,
		...batchOverrides,
	});
}

describe('decodePreCheckResult secretscan diff-scope proof (#3092)', () => {
	test('passed secretscan with a covering proof decodes as pass', () => {
		const payload = batchJson(
			{},
			{
				secretscan_preexisting_findings: [secretFinding()],
			},
		);
		expect(decodePreCheckResult(payload)).toEqual({ kind: 'pass' });
	});

	test('the same payload without the proof stays non-pass (forged passed)', () => {
		expect(decodePreCheckResult(batchJson({})).kind).not.toBe('pass');
	});

	test('a proof that does not cover every finding stays non-pass', () => {
		const payload = batchJson(
			{
				findings: [secretFinding(), secretFinding('C:/x/other.txt', 2)],
				count: 2,
			},
			{ secretscan_preexisting_findings: [secretFinding()] },
		);
		expect(decodePreCheckResult(payload).kind).not.toBe('pass');
	});

	test('truncated results block regardless of proof', () => {
		const payload = batchJson(
			{ truncated: true, message: 'Results limited to 100 findings.' },
			{ secretscan_preexisting_findings: [secretFinding()] },
		);
		expect(decodePreCheckResult(payload).kind).not.toBe('pass');
	});

	test('a count/findings total-set mismatch blocks regardless of proof', () => {
		const payload = batchJson(
			{ count: 5 },
			{ secretscan_preexisting_findings: [secretFinding()] },
		);
		expect(decodePreCheckResult(payload).kind).not.toBe('pass');
	});

	test('incomplete coverage blocks regardless of proof', () => {
		const payload = batchJson(
			{
				incomplete_files: 1,
				incomplete_paths: [{ path: 'a', reason: 'read_error' }],
			},
			{ secretscan_preexisting_findings: [secretFinding()] },
		);
		expect(decodePreCheckResult(payload).kind).not.toBe('pass');
	});

	test('zero coverage without a vacuous proof blocks regardless of proof', () => {
		const payload = batchJson(
			{ files_scanned: 0, findings: [], count: 0 },
			{ secretscan_preexisting_findings: [] },
		);
		expect(decodePreCheckResult(payload).kind).not.toBe('pass');
	});
});
