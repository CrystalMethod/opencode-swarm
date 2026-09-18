/**
 * Receipt-tool write hardening (issue #2788): the seven record_* tools persist
 * through the canonical atomic writer (exact own-temp cleanup + bounded
 * rename retry), record_trace_validation serializes its read-modify-write
 * under the per-file receipt lock, and the permits/allGreen response fields
 * mirror the gate readers' verdicts on the persisted receipt. The final
 * describe is the recurrence guardrail: the family may not reintroduce a
 * hand-rolled temp+rename persist path. Under 500 lines (FR-006).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	branchFreshnessReceiptExists,
	traceValidationReceiptExists,
} from '../../../src/hooks/issue-trace-state';
import { tryAcquireLock } from '../../../src/parallel/file-locks';
import { executeRecordBranchFreshness } from '../../../src/tools/record-branch-freshness';
import { executeRecordIssueReproduction } from '../../../src/tools/record-issue-reproduction';
import { executeRecordTraceValidation } from '../../../src/tools/record-trace-validation';
import { _internals as atomicInternals } from '../../../src/utils/atomic-write';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const HEX_A = '0123456789abcdef0123456789abcdef01234567';
const HEX_B = 'fedcba9876543210fedcba9876543210fedcba98';

const dirs: string[] = [];
function makeDir(): string {
	const dir = canonicalMkdtemp('receipt-hardening-');
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

function tmpResidue(dir: string): string[] {
	return fs
		.readdirSync(path.join(dir, '.swarm'))
		.filter((f) => f.includes('.tmp'));
}

function eperm(msg: string): NodeJS.ErrnoException {
	const err = new Error(msg) as NodeJS.ErrnoException;
	err.code = 'EPERM';
	return err;
}

/** Restore-helper: snapshot the atomic-write seam once, restore in afterEach. */
const realRenameSync = atomicInternals.renameSync;
const realWriteSync = atomicInternals.writeSync;
function restoreSeam(): void {
	atomicInternals.renameSync = realRenameSync;
	atomicInternals.writeSync = realWriteSync;
}
afterEach(restoreSeam);

describe('receipt write hardening: canonical-writer residue + retry (issue #2788)', () => {
	test('write-phase failure leaves no temp residue (v2 and v3 tools)', async () => {
		const dir = makeDir();
		atomicInternals.writeSync = () => {
			throw eperm('EPERM: forced write failure (test)');
		};
		const v2 = JSON.parse(
			await executeRecordIssueReproduction(
				{ issueNumber: 2788, performed: false },
				dir,
			),
		);
		const v3 = JSON.parse(
			await executeRecordBranchFreshness(
				{ issueNumber: 2788, freshness: 'synced' },
				dir,
			),
		);
		restoreSeam();
		expect(v2.success).toBe(false);
		expect(v3.success).toBe(false);
		expect(tmpResidue(dir)).toEqual([]);
		expect(fs.existsSync(path.join(dir, '.swarm', 'reproduction.json'))).toBe(
			false,
		);
	});

	test('rename-phase failure (retryable, exhausted) leaves no temp residue', async () => {
		const dir = makeDir();
		atomicInternals.renameSync = () => {
			throw eperm('EPERM: persistent lock (test)');
		};
		const out = JSON.parse(
			await executeRecordIssueReproduction(
				{ issueNumber: 2788, performed: false },
				dir,
			),
		);
		restoreSeam();
		expect(out.success).toBe(false);
		expect(tmpResidue(dir)).toEqual([]);
	});

	test('a single transient EPERM on the atomic rename is absorbed by retry', async () => {
		const dir = makeDir();
		let calls = 0;
		atomicInternals.renameSync = (from: string, to: string) => {
			calls += 1;
			if (calls === 1) throw eperm('EPERM: transient lock (test)');
			return realRenameSync(from, to);
		};
		const out = JSON.parse(
			await executeRecordIssueReproduction(
				{ issueNumber: 2788, performed: false },
				dir,
			),
		);
		restoreSeam();
		expect(out.success).toBe(true);
		expect(calls).toBe(2);
		expect(tmpResidue(dir)).toEqual([]);
		expect(
			JSON.parse(
				fs.readFileSync(path.join(dir, '.swarm', 'reproduction.json'), 'utf-8'),
			).performed,
		).toBe(false);
	});
});

describe('record_trace_validation: locked read-modify-write (issue #2788)', () => {
	test('concurrent upserts of distinct phases keep every entry', async () => {
		const dir = makeDir();
		const phases = ['0', '1', '2.5', '3', '4'];
		const results = await Promise.all(
			phases.map((phase) =>
				executeRecordTraceValidation(
					{
						issueNumber: 2788,
						phase,
						outcome: 'pass',
						reviewedCommit: HEX_A,
						treeId: HEX_B,
					},
					dir,
				),
			),
		);
		const receipt = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', 'trace-validation.json'),
				'utf-8',
			),
		);
		const recorded = receipt.validations.map(
			(v: { phase: string }) => v.phase,
		) as string[];
		expect(recorded.sort()).toEqual([...phases].sort());
		for (const r of results) {
			expect(JSON.parse(r).success).toBe(true);
		}
		// Serialized writers leave no residue either.
		expect(tmpResidue(dir)).toEqual([]);
	});

	test('a write failure inside the lock releases the lock and leaves no residue', async () => {
		const dir = makeDir();
		atomicInternals.writeSync = () => {
			throw eperm('EPERM: forced write failure inside lock (test)');
		};
		const failed = JSON.parse(
			await executeRecordTraceValidation(
				{
					issueNumber: 2788,
					phase: '0',
					outcome: 'pass',
					reviewedCommit: HEX_A,
					treeId: HEX_B,
				},
				dir,
			),
		);
		restoreSeam();
		expect(failed.success).toBe(false);
		expect(tmpResidue(dir)).toEqual([]);
		// The failed invocation's finally must have released the receipt lock:
		// the very next call acquires and succeeds without contention.
		const next = JSON.parse(
			await executeRecordTraceValidation(
				{
					issueNumber: 2788,
					phase: '0',
					outcome: 'pass',
					reviewedCommit: HEX_A,
					treeId: HEX_B,
				},
				dir,
			),
		);
		expect(next.success).toBe(true);
		expect(tmpResidue(dir)).toEqual([]);
	});

	test('contention returns a typed busy failure and writes nothing', async () => {
		const dir = makeDir();
		// Hold the receipt lock through the same public API the tool uses —
		// no injection seam needed for a real ELOCKED.
		const held = await tryAcquireLock(
			dir,
			'trace-validation.json',
			'test-holder',
			'test',
		);
		expect(held.acquired).toBe(true);
		try {
			const busy = JSON.parse(
				await executeRecordTraceValidation(
					{
						issueNumber: 2788,
						phase: '0',
						outcome: 'pass',
						reviewedCommit: HEX_A,
						treeId: HEX_B,
					},
					dir,
				),
			);
			expect(busy.success).toBe(false);
			expect(busy.message).toContain('locked by another concurrent writer');
			// Busy performs no mutation: no receipt file, no residue.
			expect(
				fs.existsSync(path.join(dir, '.swarm', 'trace-validation.json')),
			).toBe(false);
			expect(tmpResidue(dir)).toEqual([]);
		} finally {
			await held.lock._release?.();
		}
		// After release the same call succeeds.
		const ok = JSON.parse(
			await executeRecordTraceValidation(
				{
					issueNumber: 2788,
					phase: '0',
					outcome: 'pass',
					reviewedCommit: HEX_A,
					treeId: HEX_B,
				},
				dir,
			),
		);
		expect(ok.success).toBe(true);
	});
});

describe('verdict fields mirror the gate readers (issue #2788)', () => {
	test('allGreen equals the reader verdict over a persisted malformed entry', async () => {
		const dir = makeDir();
		fs.writeFileSync(
			path.join(dir, '.swarm', 'trace-validation.json'),
			JSON.stringify({
				issueNumber: 2788,
				timestamp: '2026-01-01T00:00:00.000Z',
				validations: [
					{
						phase: '0',
						outcome: 'pass',
						reviewedCommit: 'not-hex',
						treeId: 'not-hex',
						timestamp: '2026-01-01T00:00:00.000Z',
					},
				],
			}),
			'utf-8',
		);
		const out = JSON.parse(
			await executeRecordTraceValidation(
				{
					issueNumber: 2788,
					phase: '1',
					outcome: 'pass',
					reviewedCommit: HEX_A,
					treeId: HEX_B,
				},
				dir,
			),
		);
		const reader = await traceValidationReceiptExists(dir, 2788);
		expect(out.success).toBe(true);
		expect(out.allGreen).toBe(reader);
		expect(reader).toBe(false);
	});

	test('permits equals the reader verdict for each freshness outcome', async () => {
		const dir = makeDir();
		const synced = JSON.parse(
			await executeRecordBranchFreshness(
				{ issueNumber: 2788, freshness: 'synced' },
				dir,
			),
		);
		expect(synced.permits).toBe(await branchFreshnessReceiptExists(dir, 2788));
		expect(synced.permits).toBe(true);

		const behind = JSON.parse(
			await executeRecordBranchFreshness(
				{ issueNumber: 2788, freshness: 'behind:2' },
				dir,
			),
		);
		expect(behind.permits).toBe(await branchFreshnessReceiptExists(dir, 2788));
		expect(behind.permits).toBe(false);

		const rescued = JSON.parse(
			await executeRecordBranchFreshness(
				{
					issueNumber: 2788,
					freshness: 'fetch-failed:offline',
					override: 'user accepted the stale base',
				},
				dir,
			),
		);
		expect(rescued.permits).toBe(await branchFreshnessReceiptExists(dir, 2788));
		expect(rescued.permits).toBe(true);
	});
});

describe('guardrail: the receipt family stays on the canonical writer (issue #2788)', () => {
	// RED at base by construction: every one of these files hand-rolled a
	// temp+rename persist path before the #2788 migration.
	const family = [
		'record-issue-reproduction.ts',
		'record-issue-publication.ts',
		'record-implementation-review.ts',
		'record-recurrence-sweep.ts',
		'record-branch-freshness.ts',
		'record-trace-validation.ts',
		'record-merge-approval.ts',
	];

	test('no record_* tool constructs a temp file or persists via a direct rename', () => {
		const repoRoot = path.resolve(import.meta.dir, '../../..');
		for (const name of family) {
			const text = fs.readFileSync(
				path.join(repoRoot, 'src', 'tools', name),
				'utf-8',
			);
			expect(
				/\.tmp(?:[.-]|['"`]|$)/.test(text),
				`${name} constructs a temp file — route the persist through atomicWriteSwarmFile instead`,
			).toBe(false);
			expect(
				/fs\.promises\.(rename|writeFile)\(/.test(text),
				`${name} persists via a direct fs.promises write/rename — route the persist through atomicWriteSwarmFile instead`,
			).toBe(false);
		}
	});
});
