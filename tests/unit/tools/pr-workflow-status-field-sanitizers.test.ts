/**
 * pr_workflow_status — projection field sanitizers (issue #3095, review
 * finding F-08). Direct hostile-input unit suites for the two bounders the
 * PR_REVIEW projection routes author-influenced text through
 * (`boundUntrusted`, `boundFindingLine`), plus end-to-end proofs that a
 * hostile receipt finding and a hostile artifact candidate id surface only
 * as sanitized DISPLAY copies while identity keys stay joinable.
 *
 * There is no artifact PROSE parser in this tool (review F-06 verified moot
 * for this implementation): lane findings come from schema-validated receipt
 * envelopes and inventory ids from the gate's own canonical row parser, so
 * the exact-cap boundary of `boundFindingLine` is the tightest bound here.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _internals } from '../../../src/tools/pr-workflow-status';
import {
	persistBatch,
	SESSION_ID,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures';
import {
	BASE_CANDIDATE_HEADER,
	installProjectionGateState,
	installProjectionTestEnv,
	PROJECTION_WFI,
	placeReceiptLane,
	restoreProjectionTestEnv,
	runProjectionTool,
} from './pr-workflow-status-projection.fixtures';

const FINDING_LINE_CAP = 240;

beforeEach(() => {
	installProjectionTestEnv();
});

afterEach(async () => {
	await restoreProjectionTestEnv();
});

describe('boundUntrusted (direct hostile-input suite)', () => {
	test('clean short input passes through unchanged (joins keep working)', () => {
		expect(_internals.boundUntrusted('lane-sec', 240)).toBe('lane-sec');
		expect(_internals.boundUntrusted('CLEAN-REVIEW', 128)).toBe('CLEAN-REVIEW');
	});

	test('backticks and angle brackets are stripped', () => {
		const out = _internals.boundUntrusted(
			'`<img src=x onerror=steal()>` F-001',
			240,
		);
		expect(out).not.toContain('`');
		expect(out).not.toContain('<');
		expect(out).not.toContain('>');
		expect(out).toBe('img src=x onerror=steal() F-001');
	});

	test('control characters become spaces and whitespace collapses', () => {
		expect(_internals.boundUntrusted('\u0001a\u0002b\u0003', 240)).toBe('a b');
		expect(_internals.boundUntrusted('a \t\n b', 240)).toBe('a b');
		expect(_internals.boundUntrusted('\u001b[31mred\u001b[0m', 240)).toBe(
			'[31mred [0m',
		);
	});

	test('over-length input is capped with an ellipsis marker', () => {
		const hostile = 'A'.repeat(5013);
		const out = _internals.boundUntrusted(hostile, 128);
		expect(out.length).toBe(129);
		expect(out.endsWith('…')).toBe(true);
		expect(out.startsWith('A'.repeat(128))).toBe(true);
	});
});

describe('boundFindingLine (direct exact-bound suite)', () => {
	test('exactly at the cap passes through unchanged', () => {
		const atCap = 'x'.repeat(FINDING_LINE_CAP);
		expect(_internals.boundFindingLine(atCap)).toBe(atCap);
	});

	test('one over the cap truncates in CODE POINTS, not UTF-16 units', () => {
		const out = _internals.boundFindingLine('x'.repeat(FINDING_LINE_CAP + 1));
		expect(Array.from(out)).toHaveLength(FINDING_LINE_CAP);
		expect(out.endsWith('…')).toBe(true);
	});

	test('a surrogate pair straddling the cut is not severed', () => {
		// 240 emoji = 240 code points (480 UTF-16 units) — exactly at the cap.
		const emojiAtCap = '🔥'.repeat(FINDING_LINE_CAP);
		expect(_internals.boundFindingLine(emojiAtCap)).toBe(emojiAtCap);
		// One emoji over: the cut keeps whole code points only.
		const out = _internals.boundFindingLine('🔥'.repeat(FINDING_LINE_CAP + 1));
		expect(Array.from(out)).toHaveLength(FINDING_LINE_CAP);
		expect(out.endsWith('…')).toBe(true);
		// No lone surrogate survived: every remaining char is the full emoji.
		expect(
			Array.from(out)
				.slice(0, -1)
				.every((c) => c === '🔥'),
		).toBe(true);
	});

	test('markup and control characters are stripped before the cap', () => {
		const out = _internals.boundFindingLine('`<b>` \u0001HIGH F-1: title');
		expect(out).toBe('b HIGH F-1: title');
	});
});

describe('hostile display copies through the live projection (F-08)', () => {
	test('a hostile receipt finding surfaces only as sanitized display fields', async () => {
		installProjectionGateState({
			workflowInstanceId: PROJECTION_WFI,
			prReviewBaseDispatches: [
				{
					batchId: 'base-hos',
					lanes: [{ laneId: 'lane-hos', workflowLane: 'security-trust' }],
					validatedAt: '2026-01-01T00:00:00.000Z',
				},
			],
		});
		await placeReceiptLane({
			batchId: 'base-hos',
			laneId: 'lane-hos',
			workflowLane: 'security-trust',
			outcome: 'FINDINGS',
			findings: [
				{
					id: 'F-`x`<img src=x>',
					severity: 'HIGH',
					title: '`<script>alert(1)</script>` \u0001injected',
				},
			],
			childSessionId: 'child-hos',
		});

		const parsed = await runProjectionTool(tempDir, SESSION_ID);
		const projection = (parsed.gate as Record<string, unknown>)
			.prReviewProjection as Record<string, unknown>;
		const row = (projection.laneCoverage as Array<Record<string, unknown>>)[0];
		const summary = (row.findings as Array<Record<string, string>>)[0];
		expect(summary.id).toBe('F- x img src=x');
		expect(summary.title).toBe('script alert(1) /script injected');
		expect(String(row.latestFinding)).not.toContain('`');
		expect(String(row.latestFinding)).not.toContain('<');
		// Identity keys are NOT display copies — they stay raw for joins.
		expect(row.laneId).toBe('lane-hos');
		expect(row.batchId).toBe('base-hos');
	});

	test('a hostile over-length artifact candidate id is sanitized in the inventory', async () => {
		const lane = { laneId: 'security-trust', workflowLane: 'security-trust' };
		installProjectionGateState({
			workflowInstanceId: PROJECTION_WFI,
			prReviewBaseDispatches: [
				{
					batchId: 'base-hos-id',
					lanes: [lane],
					validatedAt: '2026-01-01T00:00:00.000Z',
				},
			],
		});
		// The gate parser validates row SHAPE, not id content: a 5013-char id
		// with markup survives the derivation and must be bounded here.
		const hostileId = `H\`${'<img src=x>'.repeat(12)}${'i'.repeat(5013)}`;
		const row = `${hostileId} | security-trust | HIGH | correctness | file.ts:1 | claim | evidence | impact | HIGH | ORDINARY | `;
		await persistBatch('base-hos-id', 'swarm-pr-review:base', [lane], {
			textOverride: [BASE_CANDIDATE_HEADER, row].join('\n'),
		});

		const parsed = await runProjectionTool(tempDir, SESSION_ID);
		const inventory = (
			(parsed.gate as Record<string, unknown>).prReviewProjection as Record<
				string,
				unknown
			>
		).inventory as Record<string, unknown>;
		expect(inventory.state).toBe('available');
		const ids = inventory.ids as string[];
		expect(ids).toHaveLength(1);
		expect(ids[0].length).toBeLessThanOrEqual(129);
		expect(ids[0]).not.toContain('`');
		expect(ids[0]).not.toContain('<');
		// The bound head still identifies the underlying id for humans.
		expect(ids[0].startsWith('H')).toBe(true);
		// The hostile tail never reaches the payload at all.
		expect(JSON.stringify(parsed)).not.toContain('i'.repeat(200));
	});
});
