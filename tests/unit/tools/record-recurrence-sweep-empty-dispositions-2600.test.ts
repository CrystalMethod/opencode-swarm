/**
 * Regression suite for issue #2600 (DD-C009): `dispositions: []` must be
 * rejected for a real defect class — by the gate reader AND by the record
 * tool. An empty dispositions array is indistinguishable from a sweep that
 * never ran; a real defect class always has at least one disposition (the
 * original defect site itself, dispositioned FIX). The non-empty and
 * "no defect class" fast-path contracts must stay green (controls).
 *
 * Under 500 lines (FR-006). bun:test only (invariant 7).
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { recurrenceSweepReceiptExists } from '../../../src/hooks/issue-trace-state';
import { executeRecordRecurrenceSweep } from '../../../src/tools/record-recurrence-sweep';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function writeReceipt(dir: string, receipt: Record<string, unknown>): string {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	const filePath = path.join(dir, '.swarm', 'recurrence-sweep.json');
	fs.writeFileSync(filePath, JSON.stringify(receipt, null, 2), 'utf-8');
	return dir;
}

const realDefectClassReceipt = (
	dispositions: unknown,
): Record<string, unknown> => ({
	issueNumber: 42,
	defectClass: 'silent noop rows in trace-engine gates',
	predicates: ['grep -n "return noop" src/hooks/'],
	dispositions,
	guardrail: {
		kind: 'runtime-assertion',
		description: 'assert each gate directive fires exactly once',
		proof: 'the frozen check fails on the buggy tree and passes post-fix',
	},
	relatedProblems: [{ ref: '#2131', note: 'residual-B gates' }],
	timestamp: '2026-01-01T00:00:00Z',
});

const fastPathReceipt = (): Record<string, unknown> => ({
	issueNumber: 42,
	defectClass: 'no defect class',
	justification: 'receipt wording corrects no incorrect behavior',
	relatedProblems: [{ ref: '#2600' }],
	timestamp: '2026-01-01T00:00:00Z',
});

describe('issue #2600 — empty dispositions rejected (reader)', () => {
	test('dispositions: [] fails the gate for a real defect class', async () => {
		const dir = writeReceipt(
			canonicalMkdtemp('rec-sweep-2600-'),
			realDefectClassReceipt([]),
		);
		expect(await recurrenceSweepReceiptExists(dir, 42)).toBe(false);
	});

	test('dispositions key omitted entirely (undefined) fails the gate too', async () => {
		// Review pr2837-r1 F8: pin the Array.isArray(undefined) === false branch
		// explicitly, so a future reader rewrite cannot silently start treating
		// a missing dispositions key as satisfied for a real defect class.
		const receipt = realDefectClassReceipt([]);
		delete receipt.dispositions;
		const dir = writeReceipt(canonicalMkdtemp('rec-sweep-2600-'), receipt);
		expect(await recurrenceSweepReceiptExists(dir, 42)).toBe(false);
	});

	test('control: a non-empty dispositions receipt still satisfies the gate', async () => {
		const dir = writeReceipt(
			canonicalMkdtemp('rec-sweep-2600-'),
			realDefectClassReceipt([
				{ ref: 'src/hooks/issue-trace-reducer.ts', disposition: 'FIX' },
			]),
		);
		expect(await recurrenceSweepReceiptExists(dir, 42)).toBe(true);
	});

	test('control: the "no defect class" fast path still satisfies the gate', async () => {
		const dir = writeReceipt(
			canonicalMkdtemp('rec-sweep-2600-'),
			fastPathReceipt(),
		);
		expect(await recurrenceSweepReceiptExists(dir, 42)).toBe(true);
	});
});

describe('issue #2600 — empty dispositions rejected (record tool)', () => {
	test('a real defect class with dispositions: [] is rejected', async () => {
		const dir = canonicalMkdtemp('rec-sweep-2600-');
		const result = JSON.parse(
			await executeRecordRecurrenceSweep(
				{
					issueNumber: 42,
					defectClass: 'silent noop rows in trace-engine gates',
					predicates: ['grep -n "return noop" src/hooks/'],
					dispositions: [],
					guardrail: {
						kind: 'runtime-assertion',
						description: 'assert each gate directive fires exactly once',
						proof:
							'the frozen check fails on the buggy tree and passes post-fix',
					},
					relatedProblems: [{ ref: '#2131' }],
				},
				dir,
				{ sessionID: 's-2600' },
			),
		) as { success: boolean; message?: string };
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/disposition/i);
		// The receipt must not be persisted on rejection.
		expect(
			fs.existsSync(path.join(dir, '.swarm', 'recurrence-sweep.json')),
		).toBe(false);
	});

	test('a real defect class with a missing dispositions array is rejected', async () => {
		const dir = canonicalMkdtemp('rec-sweep-2600-');
		const result = JSON.parse(
			await executeRecordRecurrenceSweep(
				{
					issueNumber: 42,
					defectClass: 'silent noop rows in trace-engine gates',
					predicates: ['grep -n "return noop" src/hooks/'],
					guardrail: {
						kind: 'runtime-assertion',
						description: 'assert each gate directive fires exactly once',
						proof:
							'the frozen check fails on the buggy tree and passes post-fix',
					},
					relatedProblems: [{ ref: '#2131' }],
				},
				dir,
				{ sessionID: 's-2600' },
			),
		) as { success: boolean };
		expect(result.success).toBe(false);
	});

	test('control: a non-empty dispositions sweep records successfully', async () => {
		const dir = canonicalMkdtemp('rec-sweep-2600-');
		const result = JSON.parse(
			await executeRecordRecurrenceSweep(
				{
					issueNumber: 42,
					defectClass: 'silent noop rows in trace-engine gates',
					predicates: ['grep -n "return noop" src/hooks/'],
					dispositions: [
						{
							ref: 'src/hooks/issue-trace-reducer.ts',
							disposition: 'FIX',
							note: 'rows d/g gained one-shot directives',
						},
					],
					guardrail: {
						kind: 'runtime-assertion',
						description: 'assert each gate directive fires exactly once',
						proof:
							'the frozen check fails on the buggy tree and passes post-fix',
					},
					relatedProblems: [{ ref: '#2131' }],
				},
				dir,
				{ sessionID: 's-2600' },
			),
		) as { success: boolean };
		expect(result.success).toBe(true);
	});

	test('control: the "no defect class" fast path records successfully', async () => {
		const dir = canonicalMkdtemp('rec-sweep-2600-');
		const result = JSON.parse(
			await executeRecordRecurrenceSweep(
				{
					issueNumber: 42,
					defectClass: 'no defect class',
					justification: 'receipt wording corrects no incorrect behavior',
					relatedProblems: [{ ref: '#2600' }],
				},
				dir,
				{ sessionID: 's-2600' },
			),
		) as { success: boolean };
		expect(result.success).toBe(true);
	});
});
