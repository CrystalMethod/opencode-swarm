/**
 * Issue #2918 review follow-ups (swarm-pr-review run 20260923-pr2940) —
 * docs-safe vacuous-coverage scoping (SEC-1) and the realpath-ENOENT
 * producer branch (COV-4). Split from
 * pre-check-docs-only-gate-2918.test.ts to hold the FR-006 500-line cap.
 *
 * SEC-1: only DOCS-SAFE policy exclusions (.md/.markdown/.mdx) count toward
 * policy_skipped_files. Secret-bearing policy exclusions (.db/.sqlite/
 * .dat/.bin/.lock/.log) and non-excluded scanned types keep the
 * zero-coverage fail-closed arm biting.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { decodePreCheckResult } from '../../../src/hooks/guardrails/pre-check-result';
import {
	_internals as batchInternals,
	runPreCheckBatch,
} from '../../../src/tools/pre-check-batch';
import { _internals as secretscanInternals } from '../../../src/tools/secretscan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('precheck-2918-scoping-');
	fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function write(cwd: string, file: string, content: string): void {
	const full = path.join(cwd, file);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content);
}

function scanOf(result: {
	secretscan: { result?: { success: true } | { success: false } };
}): {
	files_scanned: number;
	skipped_files: number;
	policy_skipped_files: number;
	requested_files: number;
	incomplete_files: number;
	incomplete_paths: Array<{ path: string; reason: string }>;
} {
	const res = result.secretscan.result;
	if (!res || !('files_scanned' in res)) throw new Error('no scan result');
	return res as unknown as {
		files_scanned: number;
		skipped_files: number;
		policy_skipped_files: number;
		requested_files: number;
		incomplete_files: number;
		incomplete_paths: Array<{ path: string; reason: string }>;
	};
}

async function run(cmd: string[], cwd: string): Promise<number> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'ignore',
	});
	return proc.exited;
}

/** git-init the beforeEach dir with identity + gpgsign defused. */
async function newGitProject(): Promise<string> {
	await run(['git', 'init'], dir);
	await run(['git', 'config', 'user.email', 'test@test.com'], dir);
	await run(['git', 'config', 'user.name', 'Test'], dir);
	await run(['git', 'config', 'commit.gpgsign', 'false'], dir);
	return dir;
}

describe('#2918 docs-safe vacuous-coverage scoping (SEC-1)', () => {
	test('a secret-bearing policy-excluded batch (.db/.log) does NOT vacuous-pass (docs-safe scoping)', async () => {
		const dir = await newGitProject();
		// Files EXIST (so they reach the extension-exclusion branch, not the
		// lstat-ENOENT arm) and carry plausible secret content.
		write(dir, 'dump.db', 'SQLite format 3\x00 CREATE TABLE creds...');
		write(dir, 'leaked.log', '2026-09-23 AWS_ACCESS_KEY_ID=AKIAExample\n');

		const result = await runPreCheckBatch(
			{ files: ['dump.db', 'leaked.log'], directory: dir },
			dir,
			dir,
		);

		// SEC-1 (run 20260923-pr2940): .db/.log are policy-excluded but NOT
		// docs-safe, so they never count toward policy_skipped_files — the
		// zero-coverage arm keeps this batch fail-closed exactly as at base.
		expect(result.gates_passed).toBe(false);
		const scan = scanOf(result);
		expect(scan.files_scanned).toBe(0);
		expect(scan.policy_skipped_files).toBe(0);
		expect(scan.skipped_files).toBe(2);
		expect(scan.requested_files).toBe(2);
		expect(scan.incomplete_files).toBe(0);
		const serialized = batchInternals.serializePreCheckResult(result);
		expect(decodePreCheckResult(serialized).kind).not.toBe('pass');
	});

	test('realpath-ENOENT (file removed between lstat and realpath) counts as incomplete missing', async () => {
		const dir = await newGitProject();
		// .txt files are SCANNED extensions (not policy-excluded), so they fall
		// through to the realpath call where the race is simulated.
		write(dir, 'vanish1.txt', 'one\n');
		write(dir, 'vanish2.txt', 'two\n');
		const missing1 = path.join(dir, 'vanish1.txt');
		const missing2 = path.join(dir, 'vanish2.txt');

		// Simulate the lstat-then-realpath TOCTOU race: lstat succeeds (the
		// files exist on disk), but realpathSync ENOENTs.
		const originalRealpath = secretscanInternals.realpathSync;
		secretscanInternals.realpathSync = (p: fs.PathLike) => {
			if (String(p) === missing1 || String(p) === missing2) {
				const err: NodeJS.ErrnoException = new Error('nope');
				err.code = 'ENOENT';
				throw err;
			}
			return originalRealpath(p);
		};
		try {
			const result = await runPreCheckBatch(
				{ files: ['vanish1.txt', 'vanish2.txt'], directory: dir },
				dir,
				dir,
			);

			expect(result.gates_passed).toBe(false);
			const scan = scanOf(result);
			expect(scan.files_scanned).toBe(0);
			expect(scan.policy_skipped_files).toBe(0);
			expect(scan.incomplete_files).toBe(2);
			const reasons = scan.incomplete_paths.map((entry) => entry.reason);
			expect(reasons).toContain('missing');
			const serialized = batchInternals.serializePreCheckResult(result);
			expect(decodePreCheckResult(serialized).kind).not.toBe('pass');
		} finally {
			secretscanInternals.realpathSync = originalRealpath;
		}
	});
});
