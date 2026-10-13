import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	buildVerdictSettlementReceipt,
	persistVerdictSettlementReceipt,
	readVerdictSettlementReceipt,
} from '../../../src/pr-review/verdict-settlement.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Review PRR-025 (reader arms) + PRR-014/032/033 (hardened bounded reader)
// + PRR-023 (writer-side size guard). These exercise
// `readVerdictSettlementReceipt` directly over a controlled `.swarm` tree.

const HEAD = 'abc123';
let directory = '';

const receiptPath = (phase: 'reviewer' | 'critic' = 'reviewer'): string =>
	path.join(
		directory,
		'.swarm',
		'pr-review',
		'run-1',
		`verdict-settlement.${phase}.json`,
	);

function validReceiptBody(): Record<string, unknown> {
	return {
		schemaVersion: 1,
		runId: 'run-1',
		prHeadSha: HEAD,
		revisionDigest: 'rev-1',
		phase: 'reviewer',
		items: [
			{
				itemId: 'X',
				sourceBatchId: 'b',
				sourceLaneId: 'l',
				disposition: 'liveness_dead',
				evidenceClass: 'liveness',
				terminalStatus: 'stale',
			},
		],
	};
}

beforeEach(async () => {
	directory = canonicalMkdtemp('verdict-settlement-reader-');
	await fs.mkdir(path.dirname(receiptPath()), { recursive: true });
});

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

describe('verdict settlement receipt reader arms (issue #3101, review PRR-025)', () => {
	test('a missing receipt reads as absent (ENOENT only)', async () => {
		expect(
			readVerdictSettlementReceipt(directory, 'run-1', 'reviewer'),
		).toEqual({ status: 'absent' });
	});

	test('a well-formed receipt reads back with its byte digest (anchor support)', async () => {
		await fs.writeFile(
			receiptPath(),
			JSON.stringify(validReceiptBody(), null, 2),
			'utf-8',
		);
		const read = readVerdictSettlementReceipt(directory, 'run-1', 'reviewer');
		expect(read.status).toBe('ok');
		if (read.status === 'ok') {
			expect(read.receipt.items).toHaveLength(1);
			expect(read.rawSha256).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	test('invalid JSON is invalid, not absent', async () => {
		await fs.writeFile(receiptPath(), '{not json', 'utf-8');
		const read = readVerdictSettlementReceipt(directory, 'run-1', 'reviewer');
		expect(read).toEqual({
			status: 'invalid',
			reason: 'receipt is not valid JSON',
		});
	});

	test('a schema-invalid receipt (unknown field) is invalid', async () => {
		await fs.writeFile(
			receiptPath(),
			JSON.stringify({ ...validReceiptBody(), extra: true }, null, 2),
			'utf-8',
		);
		const read = readVerdictSettlementReceipt(directory, 'run-1', 'reviewer');
		expect(read).toEqual({
			status: 'invalid',
			reason: 'receipt fails schema validation',
		});
	});

	test('an oversized receipt is refused without materializing past the bound (review PRR-023)', async () => {
		const item = {
			itemId: 'X',
			sourceBatchId: 'b',
			sourceLaneId: 'l',
			disposition: 'liveness_dead',
			evidenceClass: 'liveness',
			terminalStatus: 'stale',
		};
		const oversized = {
			schemaVersion: 1,
			runId: 'run-1',
			prHeadSha: HEAD,
			revisionDigest: 'rev-1',
			phase: 'reviewer',
			items: Array.from({ length: 5000 }, () => item),
		};
		await fs.writeFile(
			receiptPath(),
			JSON.stringify(oversized, null, 2),
			'utf-8',
		);
		const read = readVerdictSettlementReceipt(directory, 'run-1', 'reviewer');
		expect(read).toEqual({
			status: 'invalid',
			reason: 'receipt exceeds size bound',
		});
	});

	test('a symlinked receipt is refused as a non-regular file, never followed (review PRR-014)', async () => {
		const outside = path.join(directory, 'outside-receipt.json');
		await fs.writeFile(
			outside,
			JSON.stringify(validReceiptBody(), null, 2),
			'utf-8',
		);
		try {
			await fs.symlink(outside, receiptPath(), 'file');
		} catch (error) {
			// Windows hosts without symlink privilege cannot even CREATE the
			// hazard, so the lstat-before-open guard has nothing to repel on
			// this surface there; the guard executes on privileged hosts.
			if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
			throw error;
		}
		const read = readVerdictSettlementReceipt(directory, 'run-1', 'reviewer');
		expect(read.status).toBe('invalid');
		if (read.status === 'invalid') {
			expect(read.reason).not.toBe('receipt is not valid JSON');
		}
	});

	test('a receipt that is a directory is invalid, not absent (read-error taxonomy preserved, review PRR-033)', async () => {
		await fs.mkdir(receiptPath());
		const read = readVerdictSettlementReceipt(directory, 'run-1', 'reviewer');
		expect(read.status).toBe('invalid');
		if (read.status === 'invalid') {
			expect(read.reason).toMatch(
				/^receipt (must be a bounded regular file|is unreadable)/,
			);
		}
	});

	test('the writer refuses to persist a receipt the bounded reader would refuse (review PRR-023)', async () => {
		const item = {
			itemId: 'X',
			sourceBatchId: 'b',
			sourceLaneId: 'l',
			disposition: 'liveness_dead' as const,
			evidenceClass: 'liveness' as const,
			terminalStatus: 'stale' as const,
		};
		const receipt = buildVerdictSettlementReceipt({
			runId: 'run-1',
			prHeadSha: HEAD,
			revisionDigest: 'rev-1',
			phase: 'reviewer',
			items: Array.from({ length: 5000 }, () => item),
		});
		await expect(
			persistVerdictSettlementReceipt(directory, receipt),
		).rejects.toThrow(/bounded-reader cap/);
		// Nothing was written.
		await expect(fs.stat(receiptPath())).rejects.toThrow();
	});

	test('the writer persists a receipt at the schema item cap', async () => {
		const item = {
			itemId: 'X',
			sourceBatchId: 'b',
			sourceLaneId: 'l',
			disposition: 'liveness_dead' as const,
			evidenceClass: 'liveness' as const,
			terminalStatus: 'stale' as const,
		};
		const receipt = buildVerdictSettlementReceipt({
			runId: 'run-1',
			prHeadSha: HEAD,
			revisionDigest: 'rev-1',
			phase: 'reviewer',
			items: Array.from({ length: 128 }, (_v, i) => ({
				...item,
				itemId: `X-${i}`,
			})),
		});
		await persistVerdictSettlementReceipt(directory, receipt);
		const read = readVerdictSettlementReceipt(directory, 'run-1', 'reviewer');
		expect(read.status).toBe('ok');
	});
});
