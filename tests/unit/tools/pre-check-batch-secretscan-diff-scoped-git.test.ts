/**
 * Issue #3092 — real-git fixtures for the diff-scoped secretscan gate.
 *
 * Split from pre-check-batch-secretscan-diff-scoped.test.ts (FR-006 cap):
 * these tests run `runPreCheckBatch` against real temporary Git repositories
 * through the REAL `getChangedLineRanges` / `getChangedLineAmbiguousFiles`
 * producers, so the map/ambiguity plumbing is exercised end-to-end. The
 * stub-based classifier/gate matrix lives in the parent suite.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	runPreCheckBatch,
} from '../../../src/tools/pre-check-batch';
import { runSecretscanOnFiles } from '../../../src/tools/secretscan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const internalsBackup = {
	runSecretscanWrapped: _internals.runSecretscanWrapped,
	runLintWrapped: _internals.runLintWrapped,
	runSastScanWrapped: _internals.runSastScanWrapped,
	runQualityBudgetWrapped: _internals.runQualityBudgetWrapped,
};

function git(cwd: string, ...args: string[]): void {
	execFileSync('git', args, { cwd, stdio: 'pipe', timeout: 10_000 });
}

/** Real scanner through the wrapped seam; all other tools quiet. */
function realScannerTools(): void {
	_internals.runLintWrapped = (async () => ({
		ran: false,
		duration_ms: 0,
	})) as typeof _internals.runLintWrapped;
	_internals.runSastScanWrapped = (async () => ({
		ran: false,
		duration_ms: 0,
	})) as typeof _internals.runSastScanWrapped;
	_internals.runQualityBudgetWrapped = (async () => ({
		ran: false,
		duration_ms: 0,
	})) as typeof _internals.runQualityBudgetWrapped;
	_internals.runSecretscanWrapped = (async (files, directory, _g, _s, raw) => ({
		ran: true,
		result: await runSecretscanOnFiles(files, directory, raw),
		duration_ms: 1,
	})) as typeof _internals.runSecretscanWrapped;
}

/** main-branch seed commit only; tests branch from it themselves. */
function initRepoOnMain(repo: string): void {
	git(repo, 'init', '-b', 'main');
	git(repo, 'config', 'user.email', 't@example.com');
	git(repo, 'config', 'user.name', 'T');
	git(repo, 'config', 'commit.gpgsign', 'false');
	fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
	git(repo, 'add', '.');
	git(repo, 'commit', '-m', 'base');
}

beforeEach(() => {
	realScannerTools();
});

afterEach(() => {
	Object.assign(_internals, internalsBackup);
});

describe('brownfield branch fixtures through the real producer (#3092)', () => {
	test('pre-existing secret on an untouched line of a coder-touched file passes the gate', async () => {
		const repo = canonicalMkdtemp('c3092-git-brown');
		try {
			initRepoOnMain(repo);
			const before = [
				'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
				'filler',
				'tail',
				'',
			];
			const after = [
				'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
				'filler',
				'tail edited by coder',
				'',
			];
			// Pre-existing secret: committed on MAIN before the coder branch,
			// so the merge-base diff shows only the coder's line-3 edit.
			fs.writeFileSync(path.join(repo, 'legacy.txt'), before.join('\n'));
			git(repo, 'add', '.');
			git(repo, 'commit', '-m', 'legacy secret on main');
			git(repo, 'checkout', '-b', 'feature/w');
			fs.writeFileSync(path.join(repo, 'legacy.txt'), after.join('\n'));
			git(repo, 'add', '.');
			git(repo, 'commit', '-m', 'edit line 3 only');
			const result = await runPreCheckBatch({
				files: [path.join(repo, 'legacy.txt')],
				directory: repo,
				sast_enabled: false,
			});
			expect(result.gates_passed).toBe(true);
			expect(result.secretscan_preexisting_findings).toHaveLength(1);
			expect(result.secretscan.result?.count).toBe(1);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test('pre-existing secret in an UNSTAGED-only dirty file keeps the discount (single hop, review round 2)', async () => {
		const repo = canonicalMkdtemp('c3092-git-unstaged');
		try {
			initRepoOnMain(repo);
			// Pre-existing secret committed on main; coder edits line 5 only
			// in the worktree (never staged) — single hop, worktree coords.
			const base = [
				'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
				'filler',
				'filler',
				'filler',
				'tail',
				'',
			];
			fs.writeFileSync(path.join(repo, 'legacy.txt'), base.join('\n'));
			git(repo, 'add', '.');
			git(repo, 'commit', '-m', 'legacy secret on main');
			git(repo, 'checkout', '-b', 'feature/w');
			const dirty = [...base];
			dirty[4] = 'tail edited by coder';
			fs.writeFileSync(path.join(repo, 'legacy.txt'), dirty.join('\n'));
			const result = await runPreCheckBatch({
				files: [path.join(repo, 'legacy.txt')],
				directory: repo,
				sast_enabled: false,
			});
			expect(result.gates_passed).toBe(true);
			expect(result.secretscan_preexisting_findings).toHaveLength(1);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test('pre-existing secret in a STAGED-only dirty file keeps the discount (single hop, review round 2)', async () => {
		const repo = canonicalMkdtemp('c3092-git-staged');
		try {
			initRepoOnMain(repo);
			const base = [
				'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
				'filler',
				'filler',
				'filler',
				'tail',
				'',
			];
			fs.writeFileSync(path.join(repo, 'legacy.txt'), base.join('\n'));
			git(repo, 'add', '.');
			git(repo, 'commit', '-m', 'legacy secret on main');
			git(repo, 'checkout', '-b', 'feature/w');
			const dirty = [...base];
			dirty[4] = 'tail edited by coder';
			fs.writeFileSync(path.join(repo, 'legacy.txt'), dirty.join('\n'));
			git(repo, 'add', 'legacy.txt');
			// staged only; worktree == index, so index coords == worktree coords.
			const result = await runPreCheckBatch({
				files: [path.join(repo, 'legacy.txt')],
				directory: repo,
				sast_enabled: false,
			});
			expect(result.gates_passed).toBe(true);
			expect(result.secretscan_preexisting_findings).toHaveLength(1);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test('staged secret shifted by an unstaged insertion above it stays NEW (multi-hop fail-open, review round 1)', async () => {
		const repo = canonicalMkdtemp('c3092-git-mh-a');
		try {
			initRepoOnMain(repo);
			git(repo, 'checkout', '-b', 'feature/w');
			const stagedLines = [
				'a',
				'b',
				'c',
				'd',
				'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
				'',
			];
			fs.writeFileSync(path.join(repo, 's.txt'), `${stagedLines.join('\n')}\n`);
			git(repo, 'add', 's.txt');
			const shifted = ['x1', 'x2', 'x3', ...stagedLines];
			fs.writeFileSync(path.join(repo, 's.txt'), `${shifted.join('\n')}\n`);
			const result = await runPreCheckBatch({
				files: [path.join(repo, 's.txt')],
				directory: repo,
				sast_enabled: false,
			});
			expect(result.gates_passed).toBe(false);
			expect(result.secretscan_preexisting_findings).toBeUndefined();
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test('committed secret shifted by an unstaged insertion above it stays NEW (multi-hop fail-open, review round 1)', async () => {
		const repo = canonicalMkdtemp('c3092-git-mh-b');
		try {
			initRepoOnMain(repo);
			git(repo, 'checkout', '-b', 'feature/w');
			const committedLines = [
				'a',
				'b',
				'c',
				'd',
				'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
				'',
			];
			fs.writeFileSync(
				path.join(repo, 's.txt'),
				`${committedLines.join('\n')}\n`,
			);
			git(repo, 'add', '.');
			git(repo, 'commit', '-m', 'secret at line 5');
			const shifted = ['x1', 'x2', 'x3', ...committedLines];
			fs.writeFileSync(path.join(repo, 's.txt'), `${shifted.join('\n')}\n`);
			const result = await runPreCheckBatch({
				files: [path.join(repo, 's.txt')],
				directory: repo,
				sast_enabled: false,
			});
			expect(result.gates_passed).toBe(false);
			expect(result.secretscan_preexisting_findings).toBeUndefined();
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
});
