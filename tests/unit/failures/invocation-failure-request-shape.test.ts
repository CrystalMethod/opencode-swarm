import { describe, expect, test } from 'bun:test';
import { classifyProviderFailure } from '../../../src/failures/invocation-failure';
import {
	REQUEST_SHAPE_REJECTION_PATTERN,
	TRANSIENT_MODEL_ERROR_PATTERN,
} from '../../../src/utils/provider-error-classification';

const STRICT_PAYLOAD_ERROR =
	'400 {"error":{"message":"Only a single system message is supported; the request contained 2 system messages","type":"invalid_request_error"}}';

const VARIANT_PAYLOAD_ERRORS = [
	STRICT_PAYLOAD_ERROR,
	'400 Multiple system messages are not supported by this endpoint',
	'invalid_request_error: system messages are not supported more than once per request',
	'400 This model accepts one system message; got 2',
];

describe('provider.request_shape classification (#2673)', () => {
	test('the strict single-system payload rejection classifies deterministic and bounded', () => {
		const record = classifyProviderFailure(new Error(STRICT_PAYLOAD_ERROR));
		expect(record.source).toBe('provider');
		expect(record.category).toBe('provider.request_shape');
		expect(record.retryClass).toBe('do_not_retry');
		expect(record.risk).toBe('low');
	});

	test('variant phrasings of the same rejection class all classify request_shape', () => {
		for (const message of VARIANT_PAYLOAD_ERRORS) {
			const record = classifyProviderFailure(new Error(message));
			expect(record.category).toBe('provider.request_shape');
			expect(record.retryClass).toBe('do_not_retry');
		}
	});

	test('negative control: the payload never matches the transient pattern (no generic retry)', () => {
		for (const message of VARIANT_PAYLOAD_ERRORS) {
			expect(TRANSIENT_MODEL_ERROR_PATTERN.test(message)).toBe(false);
		}
		const record = classifyProviderFailure(new Error(STRICT_PAYLOAD_ERROR));
		expect(record.category).not.toBe('provider.unavailable');
		expect(record.category).not.toBe('provider.rate_limit');
		expect(record.category).not.toBe('provider.quota_billing');
	});

	test('shell-only command text still falls through to provider.unknown (unchanged)', () => {
		const record = classifyProviderFailure({
			message: 'bash: line 1: missing-tool: command not found',
		});
		expect(record.category).toBe('provider.unknown');
		expect(record.retryClass).toBe('do_not_retry');
	});

	test('transient vocabulary is NOT hijacked by the request-shape pattern', () => {
		// A genuine transient error mentioning system must still classify transient.
		const record = classifyProviderFailure(
			new Error('503 service unavailable while routing system messages'),
		);
		expect(record.category).toBe('provider.unavailable');
		expect(record.retryClass).toBe('retry_same');
	});

	test('the exported pattern is importable and disjoint from transient vocabulary', () => {
		expect(REQUEST_SHAPE_REJECTION_PATTERN.test(STRICT_PAYLOAD_ERROR)).toBe(
			true,
		);
		expect(REQUEST_SHAPE_REJECTION_PATTERN.test('rate limit exceeded')).toBe(
			false,
		);
		expect(
			REQUEST_SHAPE_REJECTION_PATTERN.test('timeout while streaming'),
		).toBe(false);
	});
});
