import { describe, expect, test } from 'bun:test';
import { evaluateIndependentOracle } from '../../../src/services/harness-optimizer/oracle.js';

describe('evaluateIndependentOracle', () => {
	test('rejects a token improvement whose artifact quality and verification fall', async () => {
		const verdict = await evaluateIndependentOracle({
			baseline: {
				n: 10,
				acceptedArtifacts: 9,
				verificationEvidence: 8,
				tokens: { input: 1000, cache: 400, output: 500 },
			},
			candidate: {
				n: 10,
				acceptedArtifacts: 5,
				verificationEvidence: 3,
				tokens: { input: 500, cache: 200, output: 250 },
			},
		});
		expect(verdict.verdict).toBe('reject');
		expect(verdict.reasons.join(' | ')).toMatch(/quality/i);
		expect(verdict.reasons.join(' | ')).toMatch(/verif/i);
	});

	test('accepts a clean improvement', async () => {
		const verdict = await evaluateIndependentOracle({
			baseline: {
				n: 10,
				acceptedArtifacts: 5,
				verificationEvidence: 3,
				tokens: { input: 1000, cache: 400, output: 500 },
			},
			candidate: {
				n: 10,
				acceptedArtifacts: 9,
				verificationEvidence: 8,
				tokens: { input: 500, cache: 200, output: 250 },
			},
		});
		expect(verdict.verdict).toBe('accept');
		expect(verdict.reasons).toHaveLength(0);
	});

	test('rejects a candidate whose token usage increases', async () => {
		const verdict = await evaluateIndependentOracle({
			baseline: {
				n: 10,
				acceptedArtifacts: 5,
				verificationEvidence: 5,
				tokens: { input: 100, cache: 100, output: 100 },
			},
			candidate: {
				n: 10,
				acceptedArtifacts: 5,
				verificationEvidence: 5,
				tokens: { input: 900, cache: 100, output: 100 },
			},
		});
		expect(verdict.verdict).toBe('reject');
		expect(verdict.reasons.join(' | ')).toMatch(/token/i);
	});

	test('unknown token totals are never treated as an improvement axis', async () => {
		const verdict = await evaluateIndependentOracle({
			baseline: {
				n: 4,
				acceptedArtifacts: 2,
				verificationEvidence: 2,
				tokens: { input: 'unknown', cache: 'unknown', output: 'unknown' },
			},
			candidate: {
				n: 4,
				acceptedArtifacts: 2,
				verificationEvidence: 2,
				tokens: { input: 'unknown', cache: 0, output: 0 },
			},
		});
		expect(verdict.verdict).toBe('accept');
	});

	test('equal quality with equal tokens is accepted (deadband neutral)', async () => {
		const verdict = await evaluateIndependentOracle({
			baseline: {
				n: 2,
				acceptedArtifacts: 1,
				verificationEvidence: 1,
				tokens: { input: 10, cache: 10, output: 10 },
			},
			candidate: {
				n: 2,
				acceptedArtifacts: 1,
				verificationEvidence: 1,
				tokens: { input: 10, cache: 10, output: 10 },
			},
		});
		expect(verdict.verdict).toBe('accept');
	});
});
