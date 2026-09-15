/**
 * v3 receipt tool executors (issue #2564): record_branch_freshness,
 * record_trace_validation, record_merge_approval. Mirrors the frozen
 * acceptance-check contracts (repro/C1, C2, C4) as repo-conventional bun:test
 * coverage for the producer side. Under 500 lines (FR-006).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeRecordBranchFreshness } from '../../../src/tools/record-branch-freshness';
import { executeRecordMergeApproval } from '../../../src/tools/record-merge-approval';
import { executeRecordTraceValidation } from '../../../src/tools/record-trace-validation';

const HEX_A = '0123456789abcdef0123456789abcdef01234567';
const HEX_B = 'fedcba9876543210fedcba9876543210fedcba98';

const dirs: string[] = [];
function makeDir(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'v3-tools-')),
	);
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	dirs.push(dir);
	return dir;
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

describe('record_branch_freshness (issue #2564, v3 Phase 0)', () => {
	test('records synced and the receipt file lands under .swarm/', async () => {
		const dir = makeDir();
		const out = JSON.parse(
			await executeRecordBranchFreshness(
				{ issueNumber: 2564, freshness: 'synced' },
				dir,
				{ sessionID: 's1' },
			),
		);
		expect(out.success).toBe(true);
		expect(out.permits).toBe(true);
		expect(
			fs.existsSync(path.join(dir, '.swarm', 'branch-freshness.json')),
		).toBe(true);
	});

	test('records behind and fetch-failed outcomes without inventing permission', async () => {
		const dir = makeDir();
		const behind = JSON.parse(
			await executeRecordBranchFreshness(
				{ issueNumber: 2564, freshness: 'behind:2' },
				dir,
			),
		);
		expect(behind.success).toBe(true);
		expect(behind.permits).toBe(false);

		const bare = JSON.parse(
			await executeRecordBranchFreshness(
				{ issueNumber: 2564, freshness: 'fetch-failed:network-offline' },
				dir,
			),
		);
		expect(bare.success).toBe(true);
		expect(bare.permits).toBe(false);

		const over = JSON.parse(
			await executeRecordBranchFreshness(
				{
					issueNumber: 2564,
					freshness: 'fetch-failed:network-offline',
					override: 'user accepted the stale base',
				},
				dir,
			),
		);
		expect(over.success).toBe(true);
		expect(over.permits).toBe(true);
	});

	test('rejects malformed freshness values and pointless overrides', async () => {
		const dir = makeDir();
		const bad = JSON.parse(
			await executeRecordBranchFreshness(
				{ issueNumber: 2564, freshness: 'stale' },
				dir,
			),
		);
		expect(bad.success).toBe(false);

		const syncedOverride = JSON.parse(
			await executeRecordBranchFreshness(
				{ issueNumber: 2564, freshness: 'synced', override: 'why' },
				dir,
			),
		);
		expect(syncedOverride.success).toBe(false);
	});
});

describe('record_trace_validation (issue #2564, per-phase validator receipts)', () => {
	test('upserts per phase: a fail entry then a pass for the same phase recovers', async () => {
		const dir = makeDir();
		const pass0 = JSON.parse(
			await executeRecordTraceValidation(
				{
					issueNumber: 2564,
					phase: '0',
					outcome: 'pass',
					reviewedCommit: HEX_A,
					treeId: HEX_B,
				},
				dir,
				{ sessionID: 's1' },
			),
		);
		expect(pass0.success).toBe(true);
		expect(pass0.allGreen).toBe(true);

		const fail46 = JSON.parse(
			await executeRecordTraceValidation(
				{
					issueNumber: 2564,
					phase: '4.6',
					outcome: 'fail',
					reviewedCommit: HEX_A,
					treeId: HEX_B,
				},
				dir,
			),
		);
		expect(fail46.success).toBe(true);
		expect(fail46.allGreen).toBe(false);

		const pass46 = JSON.parse(
			await executeRecordTraceValidation(
				{
					issueNumber: 2564,
					phase: '4.6',
					outcome: 'pass',
					reviewedCommit: HEX_A,
					treeId: HEX_B,
				},
				dir,
			),
		);
		expect(pass46.allGreen).toBe(true);

		const receipt = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', 'trace-validation.json'),
				'utf-8',
			),
		);
		expect(receipt.issueNumber).toBe(2564);
		expect(receipt.validations).toHaveLength(2);
		expect(
			receipt.validations.find((v: { phase: string }) => v.phase === '4.6')
				.outcome,
		).toBe('pass');
	});

	test('rejects unknown phases and short SHAs', async () => {
		const dir = makeDir();
		const badPhase = JSON.parse(
			await executeRecordTraceValidation(
				{
					issueNumber: 2564,
					phase: '9',
					outcome: 'pass',
					reviewedCommit: HEX_A,
					treeId: HEX_B,
				},
				dir,
			),
		);
		expect(badPhase.success).toBe(false);

		const shortSha = JSON.parse(
			await executeRecordTraceValidation(
				{
					issueNumber: 2564,
					phase: '1',
					outcome: 'pass',
					reviewedCommit: 'abc1234',
					treeId: HEX_B,
				},
				dir,
			),
		);
		expect(shortSha.success).toBe(false);
	});
});

describe('record_merge_approval (issue #2564, recorded never certified)', () => {
	test('records a bound pair and rejects mismatched SHAs at write time', async () => {
		const dir = makeDir();
		const good = JSON.parse(
			await executeRecordMergeApproval(
				{
					issueNumber: 2564,
					prHeadSha: HEX_A,
					finalCriticReviewedCommit: HEX_A,
					userApprovalVerbatim: 'User said: merge it once CI is green',
				},
				dir,
				{ sessionID: 's1' },
			),
		);
		expect(good.success).toBe(true);
		expect(fs.existsSync(path.join(dir, '.swarm', 'merge-approval.json'))).toBe(
			true,
		);

		const mismatch = JSON.parse(
			await executeRecordMergeApproval(
				{
					issueNumber: 2564,
					prHeadSha: HEX_A,
					finalCriticReviewedCommit: HEX_B,
					userApprovalVerbatim: 'User said: merge it once CI is green',
				},
				dir,
			),
		);
		expect(mismatch.success).toBe(false);
	});

	test('rejects short SHAs and empty verbatim approvals', async () => {
		const dir = makeDir();
		const short = JSON.parse(
			await executeRecordMergeApproval(
				{
					issueNumber: 2564,
					prHeadSha: 'abc1234',
					finalCriticReviewedCommit: 'abc1234',
					userApprovalVerbatim: 'approved',
				},
				dir,
			),
		);
		expect(short.success).toBe(false);

		const empty = JSON.parse(
			await executeRecordMergeApproval(
				{
					issueNumber: 2564,
					prHeadSha: HEX_A,
					finalCriticReviewedCommit: HEX_A,
					userApprovalVerbatim: '',
				},
				dir,
			),
		);
		expect(empty.success).toBe(false);
	});
});
