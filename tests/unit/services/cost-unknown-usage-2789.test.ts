import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recoverPendingCostCorrectionForTest } from '../../../src/index';
import {
	buildDelegationCostFields,
	summarizeTelemetryCosts,
} from '../../../src/services/cost-accounting';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir';

// Issue #2789: the cost fold and summaries preserve unknown (null) token
// axes end-to-end — the producer never fabricates 0 for an absent axis, an
// explicit 0 stays a KNOWN zero, and the recovery readback keeps unknown.

let testDir: string;

beforeEach(() => {
	testDir = canonicalMkdtemp('swarm-2789-fold-');
	fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	fs.rmSync(testDir, { recursive: true, force: true });
});

function writeTelemetry(lines: Array<Record<string, unknown>>): void {
	fs.writeFileSync(
		path.join(testDir, '.swarm', 'telemetry.jsonl'),
		lines.map((line) => JSON.stringify(line)).join('\n'),
	);
}

function childDigest(childSessionId: string): string {
	return createHash('sha256')
		.update(`delegation-cost-child-v1\0${childSessionId}`)
		.digest('hex')
		.slice(0, 32);
}

describe('cost fold unknown-usage semantics (#2789)', () => {
	test('buildDelegationCostFields returns null axes when no usage is held', () => {
		const fields = buildDelegationCostFields({ model: 'm' });
		expect(fields.tokens_input).toBeNull();
		expect(fields.tokens_output).toBeNull();
		expect(fields.tokens_reasoning).toBeNull();
		expect(fields.tokens_cache).toBeNull();
		expect(fields.cost_usd).toBeNull();
		expect(fields.cost_source).toBe('unavailable');
	});

	test('synthesized missing_cost evidence carries all-null usage', () => {
		const fields = buildDelegationCostFields({ model: 'm' });
		expect(fields.cost_evidence).toHaveLength(1);
		const item = fields.cost_evidence![0];
		expect(item.reason).toBe('missing_cost');
		expect(item.usage.tokens_input).toBeNull();
		expect(item.usage.tokens_output).toBeNull();
		expect(item.usage.tokens_reasoning).toBeNull();
		expect(item.usage.tokens_cache).toBeNull();
	});

	test('known usage passes verbatim; explicit zero stays known-zero', () => {
		const fields = buildDelegationCostFields({
			raw: {
				role: 'assistant',
				cost: 0.25,
				usage: { input: 10, output: 5, reasoning: 1, cache: { read: 2 } },
			},
		});
		expect(fields.tokens_input).toBe(10);
		expect(fields.tokens_output).toBe(5);
		expect(fields.tokens_reasoning).toBe(1);
		expect(fields.tokens_cache).toBe(2);

		const zeroFields = buildDelegationCostFields({
			raw: {
				role: 'assistant',
				cost: 0,
				usage: { input: 0, output: 0, reasoning: 0 },
			},
		});
		expect(zeroFields.tokens_input).toBe(0);
		expect(zeroFields.tokens_output).toBe(0);
		expect(zeroFields.tokens_reasoning).toBe(0);
	});

	test('summary totals stay null for a single all-unknown delegation', () => {
		writeTelemetry([
			{
				event: 'delegation_end',
				sessionId: 'sess-u',
				agentName: 'reviewer',
				taskId: '1.2',
				result: 'failure',
				cost_usd: null,
				cost_source: 'unavailable',
			},
		]);
		const summary = summarizeTelemetryCosts(testDir);
		expect(summary.total_input_tokens).toBeNull();
		expect(summary.total_output_tokens).toBeNull();
		expect(summary.total_reasoning_tokens).toBeNull();
		expect(summary.total_cache_tokens).toBeNull();
		expect(summary.unknown_usage_delegations).toBe(1);
		expect(summary.by_agent[0].input_tokens).toBeNull();
	});

	test('explicit-zero line keeps known-zero totals and is not flagged unknown', () => {
		writeTelemetry([
			{
				event: 'delegation_end',
				sessionId: 'sess-z',
				agentName: 'reviewer',
				taskId: '1.2',
				result: 'failure',
				tokens_input: 0,
				tokens_output: 0,
				tokens_reasoning: 0,
				tokens_cache: 0,
				cost_usd: null,
				cost_source: 'unavailable',
			},
		]);
		const summary = summarizeTelemetryCosts(testDir);
		expect(summary.total_input_tokens).toBe(0);
		expect(summary.unknown_usage_delegations).toBe(0);
	});

	test('mixed known+unknown events: totals sum known values only', () => {
		writeTelemetry([
			{
				event: 'delegation_end',
				agentName: 'coder',
				taskId: '2.1',
				tokens_input: 100,
				cost_usd: 0.01,
				cost_source: 'estimated',
			},
			{
				event: 'delegation_end',
				agentName: 'reviewer',
				taskId: '2.1',
				cost_source: 'unavailable',
			},
		]);
		const summary = summarizeTelemetryCosts(testDir);
		expect(summary.total_input_tokens).toBe(100);
		expect(summary.total_output_tokens).toBeNull();
		expect(summary.unknown_usage_delegations).toBe(1);
	});

	test('recovery readback preserves unknown instead of coercing to 0', async () => {
		const parentDigest = createHash('sha256')
			.update('delegation-cost-parent-v1\0parent-1')
			.digest('hex')
			.slice(0, 32);
		writeTelemetry([
			{
				event: 'delegation_end',
				sessionId: 'parent-1',
				agentName: 'coder',
				taskId: '1.1',
				result: 'completed',
				record_id: 'rec2789a',
				identity_fingerprint: 'a'.repeat(32),
				parent_session_digest: parentDigest,
				child_session_digest: childDigest('child-1'),
				version: 1,
				cost_usd: null,
				cost_source: 'unavailable',
			},
		]);
		const pending = await recoverPendingCostCorrectionForTest(
			testDir,
			'parent-1',
			'child-1',
		);
		expect(pending).not.toBeNull();
		expect(pending!['currentFields']['tokens_input']).toBeNull();
		expect(pending!['currentFields']['tokens_output']).toBeNull();

		writeTelemetry([
			{
				event: 'delegation_end',
				sessionId: 'parent-1',
				agentName: 'coder',
				taskId: '1.1',
				result: 'completed',
				record_id: 'rec2789b',
				identity_fingerprint: 'b'.repeat(32),
				parent_session_digest: parentDigest,
				child_session_digest: childDigest('child-2'),
				version: 1,
				tokens_input: 12,
				cost_usd: null,
				cost_source: 'unavailable',
			},
		]);
		const known = await recoverPendingCostCorrectionForTest(
			testDir,
			'parent-1',
			'child-2',
		);
		expect(known).not.toBeNull();
		expect(known!['currentFields']['tokens_input']).toBe(12);
	});

	test('fingerprint mismatch and multi-match candidates are rejected, not guessed', async () => {
		const parentDigest = createHash('sha256')
			.update('delegation-cost-parent-v1\0parent-2')
			.digest('hex')
			.slice(0, 32);
		writeTelemetry([
			{
				event: 'delegation_end',
				sessionId: 'parent-2',
				agentName: 'coder',
				taskId: '2.1',
				result: 'completed',
				record_id: 'rec2789c',
				identity_fingerprint: 'c'.repeat(32),
				parent_session_digest: parentDigest,
				child_session_digest: childDigest('child-3'),
				version: 1,
				cost_usd: null,
				cost_source: 'unavailable',
			},
		]);
		// A SECOND candidate sharing the SAME child digest makes the exact-match
		// selection ambiguous (selectedCandidates.length !== 1) — the recovery
		// must refuse rather than guess.
		writeTelemetry([
			...readTelemetryLines(testDir),
			{
				event: 'delegation_end',
				sessionId: 'parent-2',
				agentName: 'coder',
				taskId: '2.1',
				result: 'completed',
				record_id: 'rec2789d',
				identity_fingerprint: 'd'.repeat(32),
				parent_session_digest: parentDigest,
				child_session_digest: childDigest('child-3'),
				version: 1,
				cost_usd: null,
				cost_source: 'unavailable',
			},
		]);
		const ambiguous = await recoverPendingCostCorrectionForTest(
			testDir,
			'parent-2',
			'child-3',
		);
		expect(ambiguous).toBeUndefined();
	});

	test('join_miss-only directory keeps null totals (failed measurement is not vacuous zero)', () => {
		writeTelemetry([
			{ event: 'delegation_cost_join', reason: 'join_miss' },
		]);
		const summary = summarizeTelemetryCosts(testDir);
		expect(summary.delegations).toBe(0);
		expect(summary.join_miss_count).toBe(1);
		expect(summary.total_input_tokens).toBeNull();
		expect(summary.total_output_tokens).toBeNull();
	});

	test('malformed token axes stay unknown and never poison totals', () => {
		writeTelemetry([
			{
				event: 'delegation_end',
				sessionId: 'sess-bad',
				agentName: 'coder',
				taskId: '3.1',
				result: 'completed',
				tokens_input: NaN,
				tokens_output: -5,
				tokens_reasoning: 'not-a-number',
				tokens_cache: Number.POSITIVE_INFINITY,
				cost_usd: null,
				cost_source: 'unavailable',
			},
		]);
		const summary = summarizeTelemetryCosts(testDir);
		// readNumber/readFiniteNonNegative reject every malformed axis, so the
		// delegation folds to all-unknown instead of NaN-poisoning the totals.
		expect(summary.total_input_tokens).toBeNull();
		expect(summary.unknown_usage_delegations).toBe(1);
	});
});

function readTelemetryLines(directory: string): Array<Record<string, unknown>> {
	return fs
		.readFileSync(path.join(directory, '.swarm', 'telemetry.jsonl'), 'utf8')
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}
