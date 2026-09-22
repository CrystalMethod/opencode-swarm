import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { projectOtlpAttributes } from '../../../src/observability/otlp-exporter';
import {
	addTelemetryListener,
	initTelemetry,
	resetTelemetryForTesting,
	telemetry,
} from '../../../src/telemetry';

// Issue #2789: delegationEnd emits null (unknown) token axes when the
// producer did not hold a value; known numbers pass through verbatim and an
// explicit 0 stays a legal KNOWN zero.

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-2789-emit-'));
	initTelemetry(tempDir);
});

afterEach(() => {
	resetTelemetryForTesting();
	rmSync(tempDir, { recursive: true, force: true });
});

function rmSync(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function captureDelegationEnds(): Array<Record<string, unknown>> {
	const captured: Array<Record<string, unknown>> = [];
	addTelemetryListener((event, data) => {
		if (event === 'delegation_end')
			captured.push(data as Record<string, unknown>);
	});
	return captured;
}

describe('delegationEnd null-preserving token axes (#2789)', () => {
	test('absent costFields emit null token axes, never fabricated zeros', () => {
		const captured = captureDelegationEnds();
		telemetry.delegationBegin('sess-1', 'coder', '1.1');
		telemetry.delegationEnd('sess-1', 'coder', '1.1', 'completed');
		const payload = captured.find((e) => e.sessionId === 'sess-1');
		expect(payload).toBeDefined();
		expect(payload!['tokens_input']).toBeNull();
		expect(payload!['tokens_output']).toBeNull();
		expect(payload!['tokens_reasoning']).toBeNull();
		expect(payload!['tokens_cache']).toBeNull();
		expect(payload!['cost_usd']).toBeNull();
		expect(payload!['cost_source']).toBe('unavailable');
	});

	test('known numbers pass through verbatim and explicit 0 stays known-zero', () => {
		const captured = captureDelegationEnds();
		telemetry.delegationEnd('sess-2', 'coder', '1.2', 'completed', {
			tokens_input: 7,
			tokens_output: 0,
			tokens_reasoning: 3,
			tokens_cache: null,
			cost_usd: 0.5,
			cost_source: 'reported',
		});
		const payload = captured.find((e) => e.sessionId === 'sess-2');
		expect(payload).toBeDefined();
		expect(payload!['tokens_input']).toBe(7);
		expect(payload!['tokens_output']).toBe(0);
		expect(payload!['tokens_reasoning']).toBe(3);
		expect(payload!['tokens_cache']).toBeNull();
		expect(payload!['cost_usd']).toBe(0.5);
	});

	test('OTel projection omits null token axes and keeps finite zeros', () => {
		const envelopeFor = (raw: Record<string, unknown>): unknown => ({
			kind: 'delegation_end',
			observedAt: '2026-01-15T12:00:00.000Z',
			occurredAt: '2026-01-15T12:00:00.000Z',
			legacy: { raw },
		});
		const attrsNull = projectOtlpAttributes(
			envelopeFor({
				tokens_input: null,
				tokens_output: null,
				tokens_reasoning: null,
				tokens_cache: null,
			}) as never,
			'genai',
		);
		expect('gen_ai.usage.input_tokens' in attrsNull).toBe(false);
		const attrsZero = projectOtlpAttributes(
			envelopeFor({
				tokens_input: 0,
				tokens_output: 0,
				tokens_reasoning: 0,
				tokens_cache: 0,
			}) as never,
			'genai',
		);
		expect(attrsZero['gen_ai.usage.input_tokens']).toBe(0);
	});
});
