import { describe, expect, test } from 'bun:test';
import {
	_test_exports,
	executeSubmitPrReviewResult,
} from '../../../src/tools/submit-pr-review-result.js';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

/**
 * Issue #2859 (F1/F2): `submit_pr_review_result` rejections must render the
 * RECEIVED value (bounded) next to the expected-value message so a child that
 * sent the wrong shape can self-diagnose instead of retrying blind, and the
 * string form "1" must clear the schemaVersion literal.
 */

const {
	renderReceivedValue,
	formatSubmitValidationIssues,
	noteSubmitRejection,
	clearSubmitRejections,
	MAX_TRACKED_SUBMIT_SESSIONS,
} = _test_exports;

function validEnvelope(): Record<string, unknown> {
	return {
		schemaVersion: 1,
		outcome: 'CLEAN',
		creditedLanes: ['intent-architecture'],
		findings: [],
		cleanAttestations: [
			{
				workflowLane: 'intent-architecture',
				coverageScope: 'Reviewed the complete changed architecture surface.',
				evidence: 'No reachable architecture defect remains in the bound diff.',
			},
		],
		unresolved: [],
	};
}

function parseResult(value: string): { success: boolean; message?: string } {
	return JSON.parse(value) as { success: boolean; message?: string };
}

describe('renderReceivedValue (issue #2859 F1)', () => {
	test('renders strings with JSON quotes and typeof', () => {
		expect(renderReceivedValue('2')).toBe('received "2" (string)');
	});

	test('renders numbers, booleans, null, and undefined', () => {
		expect(renderReceivedValue(2)).toBe('received 2 (number)');
		expect(renderReceivedValue(true)).toBe('received true (boolean)');
		expect(renderReceivedValue(null)).toBe('received null (object)');
		expect(renderReceivedValue(undefined)).toBe('received undefined');
	});

	test('truncates oversized renderings and never throws on circular input', () => {
		const long = 'x'.repeat(5000);
		const rendered = renderReceivedValue(long);
		expect(rendered.length).toBeLessThan(160);
		expect(rendered).toContain('…');
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(renderReceivedValue(circular)).toContain('<unrepresentable>');
	});
});

describe('formatSubmitValidationIssues (issue #2859 F1)', () => {
	test('renders the received value for a keyed issue', () => {
		const rendered = formatSubmitValidationIssues({ schemaVersion: '2' }, [
			{ path: ['schemaVersion'], message: 'Invalid input: expected 1' },
		] as never);
		expect(rendered).toContain('schemaVersion: Invalid input: expected 1');
		expect(rendered).toContain('received "2" (string)');
	});

	test('renders the received value for an unrecognized key (empty path)', () => {
		const rendered = formatSubmitValidationIssues({ unexpectedKey: 7 }, [
			{
				path: [],
				message: 'Unrecognized key: "unexpectedKey"',
			},
		] as never);
		expect(rendered).toContain('(root): Unrecognized key: "unexpectedKey"');
		expect(rendered).toContain('received 7 (number)');
	});
});

describe('submit_pr_review_result rejection diagnostics — regression: child-blind rejections (F1)', () => {
	// Previous behavior: the rejection rendered only `path: message`, so
	// schemaVersion "1", 2, "2", true, and null all produced the identical
	// string `Invalid input: expected 1` — a child could not self-diagnose.
	test('a rejected schemaVersion renders the received value and typeof', async () => {
		const result = parseResult(
			await executeSubmitPrReviewResult(
				{
					schemaVersion: '2',
					revisionDigest: 'd'.repeat(64),
					result: validEnvelope(),
				},
				canonicalTmpDir(),
				{ sessionID: 'child-2859-f1a' },
			),
		);
		expect(result.success).toBeFalse();
		expect(result.message).toContain('Invalid PR-review result');
		expect(result.message).toContain('expected 1');
		expect(result.message).toContain('received "2" (string)');
	});

	test('a rejected regex digest renders the received value', async () => {
		const result = parseResult(
			await executeSubmitPrReviewResult(
				{
					schemaVersion: 1,
					revisionDigest: 'ZZZ-not-a-sha',
					result: validEnvelope(),
				},
				canonicalTmpDir(),
				{ sessionID: 'child-2859-f1b' },
			),
		);
		expect(result.success).toBeFalse();
		expect(result.message).toContain('received "ZZZ-not-a-sha" (string)');
	});

	test('oversized received values render bounded (<800 chars, no 120+ char run)', async () => {
		const result = parseResult(
			await executeSubmitPrReviewResult(
				{
					schemaVersion: 1,
					revisionDigest: 'y'.repeat(5000),
					result: validEnvelope(),
				},
				canonicalTmpDir(),
				{ sessionID: 'child-2859-f1c' },
			),
		);
		expect(result.message?.length ?? 0).toBeLessThan(800);
		expect(result.message).not.toContain('x'.repeat(121));
	});

	test('a circular sibling value never throws and stays bounded', async () => {
		const args: Record<string, unknown> = {
			schemaVersion: 1,
			revisionDigest: 'd'.repeat(64),
			result: validEnvelope(),
		};
		const circular: Record<string, unknown> = { boom: true };
		circular.self = circular;
		args.circularSibling = circular;
		const result = parseResult(
			await executeSubmitPrReviewResult(args, canonicalTmpDir(), {
				sessionID: 'child-2859-f1d',
			}),
		);
		expect(result.success).toBeFalse();
		expect(result.message).toContain('<unrepresentable>');
	});

	test('the escalating hint appears on the 3rd consecutive rejection, not the 1st', async () => {
		const directory = canonicalTmpDir();
		const sessionID = 'child-2859-f1e';
		const args = {
			schemaVersion: '2',
			revisionDigest: 'd'.repeat(64),
			result: validEnvelope(),
		};
		const first = parseResult(
			await executeSubmitPrReviewResult(args, directory, { sessionID }),
		);
		expect(first.message).not.toMatch(/consecutive|re-read/i);
		await executeSubmitPrReviewResult(args, directory, { sessionID });
		const third = parseResult(
			await executeSubmitPrReviewResult(args, directory, { sessionID }),
		);
		expect(third.message).toMatch(/consecutive|re-read/i);
		expect(third.message).toContain('do NOT resubmit the same payload shape');
	});

	test('response shape stays { success, message }', async () => {
		const raw = await executeSubmitPrReviewResult(
			{
				schemaVersion: '2',
				revisionDigest: 'd'.repeat(64),
				result: validEnvelope(),
			},
			canonicalTmpDir(),
			{ sessionID: 'child-2859-f1f' },
		);
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		expect(Object.keys(parsed).sort()).toEqual(['message', 'success']);
	});
});

describe('submit_pr_review_result schemaVersion coercion — regression: string "1" rejected (F2)', () => {
	// Previous behavior: z.literal(1) rejected the unambiguous string form,
	// which is exactly the blind-retry trap the PR #2824 lanes hit.
	test('the string "1" clears the schema (parse accepted; no schema-rejection prefix)', async () => {
		const result = parseResult(
			await executeSubmitPrReviewResult(
				{
					schemaVersion: '1',
					revisionDigest: 'd'.repeat(64),
					result: validEnvelope(),
				},
				canonicalTmpDir(),
				{ sessionID: 'child-2859-f2a' },
			),
		);
		// Parse accepted: the schema-rejection message is gone. The downstream
		// gate outcome for this synthetic session carries `reason`/`status`
		// (gate-layer rejection) and NO `message` key at all.
		expect(result.message).toBeUndefined();
		expect(result.success).toBeFalse();
	});

	test('2, "2", true, and null stay rejected with received renderings', async () => {
		for (const schemaVersion of [2, '2', true, null]) {
			const result = parseResult(
				await executeSubmitPrReviewResult(
					{
						schemaVersion,
						revisionDigest: 'd'.repeat(64),
						result: validEnvelope(),
					},
					canonicalTmpDir(),
					{ sessionID: 'child-2859-f2b' },
				),
			);
			expect(result.success).toBeFalse();
			expect(result.message).toContain(
				'Invalid PR-review result: schemaVersion',
			);
			expect(result.message).toContain('expected 1');
			// `true` specifically guards against a naive z.coerce.number() port
			// (Number(true) === 1) that would wrongly accept it.
			expect(result.message).toContain(
				`received ${JSON.stringify(schemaVersion) ?? 'null'} (${typeof schemaVersion})`,
			);
		}
	});
});

describe('consecutive-rejection tracker eviction (issue #2859 F1, AGENTS.md §8)', () => {
	test('FIFO eviction keeps the map bounded at MAX_TRACKED_SUBMIT_SESSIONS', () => {
		const directory = canonicalTmpDir();
		for (let index = 0; index < MAX_TRACKED_SUBMIT_SESSIONS + 8; index++) {
			noteSubmitRejection(directory, `session-${index}`);
		}
		// The oldest 8 sessions were evicted in insertion order: re-noting an
		// evicted session starts a fresh count at 1 rather than continuing it.
		expect(noteSubmitRejection(directory, 'session-0')).toBe(1);
		expect(noteSubmitRejection(directory, 'session-7')).toBe(1);
		// A surviving (recent) session continues its count.
		const survivor = `session-${MAX_TRACKED_SUBMIT_SESSIONS + 7}`;
		expect(noteSubmitRejection(directory, survivor)).toBe(2);
		clearSubmitRejections(directory, survivor);
	});
});
