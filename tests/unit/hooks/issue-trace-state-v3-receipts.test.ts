/**
 * v3 receipt readers (issue #2564): branchFreshnessReceiptExists,
 * traceValidationReceiptExists, mergeApprovalReceiptExists in
 * src/hooks/issue-trace-state.ts. Mirrors the frozen acceptance-check
 * contracts (repro/C1, C2, C4) as repo-conventional bun:test coverage for the
 * reader side. Under 500 lines (FR-006).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	branchFreshnessReceiptExists,
	mergeApprovalReceiptExists,
	traceValidationReceiptExists,
} from '../../../src/hooks/issue-trace-state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const HEX_A = '0123456789abcdef0123456789abcdef01234567';
const HEX_B = 'fedcba9876543210fedcba9876543210fedcba98';

const dirs: string[] = [];
function makeDir(): string {
	const dir = canonicalMkdtemp('v3-readers-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	dirs.push(dir);
	return dir;
}
function writeReceipt(dir: string, name: string, data: unknown): void {
	fs.writeFileSync(
		path.join(dir, '.swarm', name),
		JSON.stringify(data, null, 2),
		'utf-8',
	);
}
afterEach(() => {
	for (const d of dirs.splice(0)) {
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

describe('branchFreshnessReceiptExists (mirrors trace-check.sh phase0)', () => {
	test('synced permits; behind never permits', async () => {
		const dir = makeDir();
		writeReceipt(dir, 'branch-freshness.json', {
			issueNumber: 2564,
			freshness: 'synced',
		});
		expect(await branchFreshnessReceiptExists(dir, 2564)).toBe(true);

		writeReceipt(dir, 'branch-freshness.json', {
			issueNumber: 2564,
			freshness: 'behind:3',
		});
		expect(await branchFreshnessReceiptExists(dir, 2564)).toBe(false);
	});

	test('fetch-failed fails closed without an override, permits with one', async () => {
		const dir = makeDir();
		writeReceipt(dir, 'branch-freshness.json', {
			issueNumber: 2564,
			freshness: 'fetch-failed:auth-revoked',
		});
		expect(await branchFreshnessReceiptExists(dir, 2564)).toBe(false);

		writeReceipt(dir, 'branch-freshness.json', {
			issueNumber: 2564,
			freshness: 'fetch-failed:auth-revoked',
			override: 'user said proceed on the stale base',
		});
		expect(await branchFreshnessReceiptExists(dir, 2564)).toBe(true);
	});

	test('issue-bound and malformed-fail-closed', async () => {
		const dir = makeDir();
		writeReceipt(dir, 'branch-freshness.json', {
			issueNumber: 2564,
			freshness: 'synced',
		});
		expect(await branchFreshnessReceiptExists(dir, 999)).toBe(false);

		writeReceipt(dir, 'branch-freshness.json', {
			issueNumber: 2564,
			freshness: 'weird-value',
		});
		expect(await branchFreshnessReceiptExists(dir, 2564)).toBe(false);
	});
});

describe('traceValidationReceiptExists (per-phase validator receipts)', () => {
	test('empty or absent receipt fails closed', async () => {
		const dir = makeDir();
		expect(await traceValidationReceiptExists(dir, 2564)).toBe(false);

		writeReceipt(dir, 'trace-validation.json', {
			issueNumber: 2564,
			validations: [],
		});
		expect(await traceValidationReceiptExists(dir, 2564)).toBe(false);
	});

	test('all-pass entries satisfy; any fail entry or malformed SHA fails closed', async () => {
		const dir = makeDir();
		writeReceipt(dir, 'trace-validation.json', {
			issueNumber: 2564,
			validations: [
				{ phase: '0', outcome: 'pass', reviewedCommit: HEX_A, treeId: HEX_B },
				{
					phase: '4.6',
					outcome: 'pass',
					reviewedCommit: HEX_A,
					treeId: HEX_B,
				},
			],
		});
		expect(await traceValidationReceiptExists(dir, 2564)).toBe(true);

		writeReceipt(dir, 'trace-validation.json', {
			issueNumber: 2564,
			validations: [
				{ phase: '0', outcome: 'pass', reviewedCommit: HEX_A, treeId: HEX_B },
				{
					phase: '4.6',
					outcome: 'fail',
					reviewedCommit: HEX_A,
					treeId: HEX_B,
				},
			],
		});
		expect(await traceValidationReceiptExists(dir, 2564)).toBe(false);

		writeReceipt(dir, 'trace-validation.json', {
			issueNumber: 2564,
			validations: [
				{ phase: '0', outcome: 'pass', reviewedCommit: 'abc', treeId: HEX_B },
			],
		});
		expect(await traceValidationReceiptExists(dir, 2564)).toBe(false);

		expect(await traceValidationReceiptExists(dir, 999)).toBe(false);
	});
});

describe('mergeApprovalReceiptExists (recorded, never certified)', () => {
	test('bound 40-hex pair satisfies; mismatch or short SHA fails closed', async () => {
		const dir = makeDir();
		writeReceipt(dir, 'merge-approval.json', {
			issueNumber: 2564,
			prHeadSha: HEX_A,
			finalCriticReviewedCommit: HEX_A,
			userApprovalVerbatim: 'approved by the user',
		});
		expect(await mergeApprovalReceiptExists(dir, 2564)).toBe(true);
		expect(await mergeApprovalReceiptExists(dir, 999)).toBe(false);

		writeReceipt(dir, 'merge-approval.json', {
			issueNumber: 2564,
			prHeadSha: HEX_A,
			finalCriticReviewedCommit: HEX_B,
			userApprovalVerbatim: 'approved by the user',
		});
		expect(await mergeApprovalReceiptExists(dir, 2564)).toBe(false);

		writeReceipt(dir, 'merge-approval.json', {
			issueNumber: 2564,
			prHeadSha: 'short',
			finalCriticReviewedCommit: 'short',
			userApprovalVerbatim: 'approved by the user',
		});
		expect(await mergeApprovalReceiptExists(dir, 2564)).toBe(false);
	});
});
