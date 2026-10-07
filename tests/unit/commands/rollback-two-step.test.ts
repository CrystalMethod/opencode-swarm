/**
 * Issue #2946: /swarm rollback adopts preview + confirm token + auto-backup.
 *
 * Drives the REAL handlers (handleRollbackCommand, the checkpoint tool) with
 * real git in scratch repositories — no mock.module, no _internals stubs
 * except the documented failure-injection case (git status unreadable).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { handleRollbackCommand } from '../../../src/commands/rollback';
import { _rollbackGateInternals } from '../../../src/commands/rollback-gate';
import { checkpoint } from '../../../src/tools/checkpoint';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function git(args: string[], cwd: string): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

/** Real scratch git repo with one committed file and one saved checkpoint. */
async function scratchRepo(
	fileName = 'src.txt',
): Promise<{ dir: string; file: string; label: string }> {
	const dir = canonicalMkdtemp('rollback-two-step-');
	git(['init', '-q'], dir);
	git(['config', 'user.email', 'test@example.com'], dir);
	git(['config', 'user.name', 'Test'], dir);
	git(['config', 'commit.gpgsign', 'false'], dir);
	const file = path.join(dir, fileName);
	fs.writeFileSync(file, 'committed-content-v1');
	git(['add', '.'], dir);
	git(['commit', '-q', '-m', 'init'], dir);
	const label = 'before-risky-op';
	const result = await checkpoint.execute({ action: 'save', label }, {
		directory: dir,
	} as ToolContext);
	if (!String(result).includes('"success": true')) {
		throw new Error(`checkpoint save failed: ${String(result)}`);
	}
	return { dir, file, label };
}

function readDirty(dir: string, fileName = 'src.txt'): string {
	return git(['status', '--porcelain'], dir)
		.split('\n')
		.filter((l) => l.trim() !== '' && !l.startsWith('??'))
		.join('\n');
}

function backupDirs(dir: string): string[] {
	const root = path.join(dir, '.swarm', 'rollback-backups');
	if (!fs.existsSync(root)) return [];
	return fs
		.readdirSync(root, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name);
}

function sentinelFound(dir: string, sentinel: string): boolean {
	const root = path.join(dir, '.swarm', 'rollback-backups');
	if (!fs.existsSync(root)) return false;
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const p = path.join(current, entry.name);
			if (entry.isDirectory()) stack.push(p);
			else {
				try {
					if (fs.readFileSync(p, 'utf-8').includes(sentinel)) return true;
				} catch {
					// unreadable backup entry — keep scanning
				}
			}
		}
	}
	return false;
}

const scratchDirs: string[] = [];
function track(dir: string): string {
	scratchDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (scratchDirs.length > 0) {
		const dir = scratchDirs.pop() as string;
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

describe('rollback two-step gate — git checkpoint path (#2946)', () => {
	test('dirty tree previews and does not reset', async () => {
		const { dir, file, label } = await scratchRepo();
		track(dir);
		fs.writeFileSync(file, 'UNCOMMITTED-EDIT-MUST-SURVIVE');

		const out = await handleRollbackCommand(dir, [label]);

		expect(out).toContain('--confirm=');
		expect(out).toContain('src.txt');
		expect(out).not.toContain('Rolled back to checkpoint');
		expect(fs.readFileSync(file, 'utf-8')).toBe(
			'UNCOMMITTED-EDIT-MUST-SURVIVE',
		);
		expect(readDirty(dir)).toContain('src.txt');
		expect(backupDirs(dir)).toEqual([]);
	});

	test('confirm token executes, backs up destroyed bytes, and restores', async () => {
		const { dir, file, label } = await scratchRepo();
		track(dir);
		fs.writeFileSync(file, 'PRECIOUS-UNCOMMITTED-EDIT');

		const preview = await handleRollbackCommand(dir, [label]);
		const token = /--confirm=([A-Za-z0-9]+)/.exec(preview)?.[1];
		expect(token).toBeTruthy();

		const out = await handleRollbackCommand(dir, [label, `--confirm=${token}`]);

		expect(out).toContain('Rolled back to checkpoint');
		// The edit was destroyed by the confirmed restore...
		expect(fs.readFileSync(file, 'utf-8')).toBe('committed-content-v1');
		// ...and its pre-reset bytes are recoverable from the backup.
		expect(backupDirs(dir).length).toBe(1);
		expect(sentinelFound(dir, 'PRECIOUS-UNCOMMITTED-EDIT')).toBe(true);
	});

	test('wrong token refuses without resetting', async () => {
		const { dir, file, label } = await scratchRepo();
		track(dir);
		fs.writeFileSync(file, 'UNCOMMITTED-EDIT-MUST-SURVIVE');

		await handleRollbackCommand(dir, [label]); // mint (single-slot)
		const out = await handleRollbackCommand(dir, [
			label,
			'--confirm=deadbeefdeadbeefdeadbeef',
		]);

		expect(out).toContain('Error:');
		expect(out).not.toContain('Rolled back to checkpoint');
		expect(fs.readFileSync(file, 'utf-8')).toBe(
			'UNCOMMITTED-EDIT-MUST-SURVIVE',
		);
	});

	test('tree dirtied between preview and confirm is refused (TOCTOU)', async () => {
		const { dir, file, label } = await scratchRepo();
		track(dir);
		fs.writeFileSync(file, 'FIRST-EDIT');
		const preview = await handleRollbackCommand(dir, [label]);
		const token = /--confirm=([A-Za-z0-9]+)/.exec(preview)?.[1];

		const second = path.join(dir, 'other.txt');
		fs.writeFileSync(second, 'SECOND-EDIT');
		git(['add', 'other.txt'], dir);

		const out = await handleRollbackCommand(dir, [label, `--confirm=${token}`]);

		expect(out.toLowerCase()).toContain('scope changed');
		expect(out).not.toContain('Rolled back to checkpoint');
		expect(fs.readFileSync(file, 'utf-8')).toBe('FIRST-EDIT');
		expect(fs.readFileSync(second, 'utf-8')).toBe('SECOND-EDIT');
	});

	test('clean tree restores in a single call (no token demanded)', async () => {
		const { dir, file, label } = await scratchRepo();
		track(dir);

		const out = await handleRollbackCommand(dir, [label]);

		expect(out).toContain('Rolled back to checkpoint');
		expect(out).not.toContain('--confirm=');
	});

	test('--yes executes in one invocation with a backup', async () => {
		const { dir, file, label } = await scratchRepo();
		track(dir);
		fs.writeFileSync(file, 'BACKUP-SENTINEL-VIA-YES');

		const out = await handleRollbackCommand(dir, [label, '--yes']);

		expect(out).toContain('Rolled back to checkpoint');
		expect(fs.readFileSync(file, 'utf-8')).toBe('committed-content-v1');
		expect(backupDirs(dir).length).toBe(1);
		expect(sentinelFound(dir, 'BACKUP-SENTINEL-VIA-YES')).toBe(true);
	});

	test('non-ASCII filename survives the full preview → confirm → backup flow (#2946 review finding 1)', async () => {
		const { dir, label } = await scratchRepo('café.txt');
		track(dir);
		const file = path.join(dir, 'café.txt');
		fs.writeFileSync(file, 'PRÉCIEUX-CONTENU-UNICODE');

		const preview = await handleRollbackCommand(dir, [label]);
		expect(preview).toContain('--confirm=');
		// The -z status parse must carry the verbatim name, not git's
		// core.quotepath C-escaped form — the preview names the real file.
		expect(preview).toContain('café.txt');
		const token = /--confirm=([A-Za-z0-9]+)/.exec(preview)?.[1];

		const out = await handleRollbackCommand(dir, [label, `--confirm=${token}`]);

		expect(out).toContain('Rolled back to checkpoint');
		// The backup safety net is surfaced to the CLI caller (#2976 F-3).
		expect(out).toContain('backed up to');
		expect(fs.readFileSync(file, 'utf-8')).toBe('committed-content-v1');
		// The pre-reset bytes of the non-ASCII-named file are recoverable.
		expect(backupDirs(dir).length).toBe(1);
		expect(sentinelFound(dir, 'PRÉCIEUX-CONTENU-UNICODE')).toBe(true);
	});

	test('untracked file at a path the checkpoint tree tracks is gated and backed up (#2976 F-1)', async () => {
		const dir = canonicalMkdtemp('rollback-untracked-');
		track(dir);
		git(['init', '-q'], dir);
		git(['config', 'user.email', 'test@example.com'], dir);
		git(['config', 'user.name', 'Test'], dir);
		git(['config', 'commit.gpgsign', 'false'], dir);
		const envFile = path.join(dir, 'env.txt');
		fs.writeFileSync(envFile, 'checkpointed-v1\n');
		git(['add', '.'], dir);
		git(['commit', '-q', '-m', 'with-env'], dir);
		const label = 'before-cleanup';
		const save = await checkpoint.execute({ action: 'save', label }, {
			directory: dir,
		} as ToolContext);
		expect(String(save)).toContain('"success": true');
		// Remove env.txt from the repo in a LATER commit; recreate it on disk
		// as an UNTRACKED file holding precious bytes. The checkpoint tree
		// still tracks env.txt, so reset --hard would silently overwrite it.
		git(['rm', '-q', 'env.txt'], dir);
		git(['commit', '-q', '-m', 'drop-env'], dir);
		fs.writeFileSync(envFile, 'UNTRACKED-PRECIOUS\n');
		// Sanity: the gate must NOT read this tree as clean.
		const status = git(['status', '--porcelain', '-z'], dir);
		expect(git(['ls-files'], dir)).not.toContain('env.txt');

		const preview = await handleRollbackCommand(dir, [label]);
		expect(preview).toContain('--confirm=');
		expect(preview).toContain('env.txt');
		const token = /--confirm=([A-Za-z0-9]+)/.exec(preview)?.[1];

		const out = await handleRollbackCommand(dir, [label, `--confirm=${token}`]);

		expect(out).toContain('Rolled back to checkpoint');
		// The reset materialized the checkpoint's env.txt over the untracked
		// bytes — which must have been backed up first.
		expect(fs.readFileSync(envFile, 'utf-8').replace(/\r\n/g, '\n')).toBe(
			'checkpointed-v1\n',
		);
		expect(backupDirs(dir).length).toBe(1);
		expect(sentinelFound(dir, 'UNTRACKED-PRECIOUS')).toBe(true);
		// The pre-fix tracked-only parser would have seen this tree as clean.
		expect(status).toContain('env.txt');
	});

	test('intent-to-add worktree rename of an R/C-initial file does not swallow other dirty paths (#2976 F-2)', async () => {
		const dir = canonicalMkdtemp('rollback-rename-');
		track(dir);
		git(['init', '-q'], dir);
		git(['config', 'user.email', 'test@example.com'], dir);
		git(['config', 'user.name', 'Test'], dir);
		git(['config', 'commit.gpgsign', 'false'], dir);
		fs.writeFileSync(path.join(dir, 'README.md'), 'readme-v1\n');
		fs.writeFileSync(path.join(dir, 'a.txt'), 'a-v1\n');
		git(['add', '.'], dir);
		git(['commit', '-q', '-m', 'init'], dir);
		const label = 'gate';
		const save = await checkpoint.execute({ action: 'save', label }, {
			directory: dir,
		} as ToolContext);
		expect(String(save)).toContain('"success": true');

		// Worktree-only rename via intent-to-add; the ORIG_PATH (README.md)
		// starts with uppercase R — the shape that broke the first-column
		// rename test in the -z parser.
		fs.renameSync(path.join(dir, 'README.md'), path.join(dir, 'docs.md'));
		git(['add', '-N', 'docs.md'], dir);
		fs.writeFileSync(path.join(dir, 'a.txt'), 'a-EDITED-MUST-SURVIVE\n');

		const preview = await handleRollbackCommand(dir, [label]);
		expect(preview).toContain('--confirm=');
		// The second dirty file must be named — the pre-fix parser swallowed
		// it behind a bogus path parsed out of the rename ORIG token.
		expect(preview).toContain('a.txt');
		expect(preview).not.toMatch(/\bDME\.md\b/);
		const token = /--confirm=([A-Za-z0-9]+)/.exec(preview)?.[1];

		const out = await handleRollbackCommand(dir, [label, `--confirm=${token}`]);

		expect(out).toContain('Rolled back to checkpoint');
		expect(backupDirs(dir).length).toBe(1);
		expect(sentinelFound(dir, 'a-EDITED-MUST-SURVIVE')).toBe(true);
	});

	test('backup safety net is surfaced: an incomplete backup refuses the restore (#2976 F-3)', async () => {
		const { dir, file, label } = await scratchRepo();
		track(dir);
		fs.writeFileSync(file, 'UNCOMMITTED-EDIT-MUST-SURVIVE');
		const preview = await handleRollbackCommand(dir, [label]);
		const token = /--confirm=([A-Za-z0-9]+)/.exec(preview)?.[1];
		expect(token).toBeTruthy();
		// Sabotage the backup root: a plain file where the backup directory
		// tree must be created makes every copy fail.
		fs.rmSync(path.join(dir, '.swarm', 'rollback-backups'), {
			recursive: true,
			force: true,
		});
		fs.writeFileSync(path.join(dir, '.swarm', 'rollback-backups'), 'not a dir');

		const out = await handleRollbackCommand(dir, [label, `--confirm=${token}`]);

		expect(out).toContain('backup incomplete');
		expect(out).toContain('refused');
		expect(out).toContain('Warnings:');
		// Nothing was destroyed.
		expect(fs.readFileSync(file, 'utf-8')).toBe(
			'UNCOMMITTED-EDIT-MUST-SURVIVE',
		);
		expect(out).not.toContain('Rolled back to checkpoint');
	});

	test('--yes together with --confirm is rejected as contradictory input', async () => {
		const { dir, file, label } = await scratchRepo();
		track(dir);
		fs.writeFileSync(file, 'UNCOMMITTED-EDIT-MUST-SURVIVE');

		const out = await handleRollbackCommand(dir, [
			label,
			'--yes',
			'--confirm=whatever',
		]);

		expect(out).toContain('not both');
		expect(out).not.toContain('Rolled back to checkpoint');
		expect(fs.readFileSync(file, 'utf-8')).toBe(
			'UNCOMMITTED-EDIT-MUST-SURVIVE',
		);
	});

	test('unreadable git status fails closed (refuses without a clean read)', async () => {
		const { dir, file, label } = await scratchRepo();
		track(dir);
		fs.writeFileSync(file, 'UNCOMMITTED-EDIT-MUST-SURVIVE');
		const realRunGit = _rollbackGateInternals.runGit;
		// #2508 contract: a failed status read in a REAL repository is never a
		// clean tree. Injection seam: _rollbackGateInternals.runGit.
		_rollbackGateInternals.runGit = () => null;
		try {
			const out = await handleRollbackCommand(dir, [label]);
			expect(out).toContain('cannot verify the working tree');
			expect(out).not.toContain('Rolled back to checkpoint');
			expect(fs.readFileSync(file, 'utf-8')).toBe(
				'UNCOMMITTED-EDIT-MUST-SURVIVE',
			);
		} finally {
			_rollbackGateInternals.runGit = realRunGit;
		}
	});
});

describe('rollback two-step gate — legacy phase path (#2946)', () => {
	function scratchLegacy(): string {
		const dir = track(canonicalMkdtemp('rollback-legacy-'));
		fs.mkdirSync(path.join(dir, '.swarm', 'checkpoints', 'phase-1'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(dir, '.swarm', 'checkpoints', 'manifest.json'),
			JSON.stringify({
				checkpoints: [
					{ phase: 1, label: 'kickoff', timestamp: '2026-01-01T00:00:00.000Z' },
				],
			}),
		);
		fs.writeFileSync(
			path.join(dir, '.swarm', 'checkpoints', 'phase-1', 'context.md'),
			'CHECKPOINT-CONTEXT',
		);
		// Live state differing from the checkpoint.
		fs.writeFileSync(path.join(dir, '.swarm', 'context.md'), 'LIVE-CONTEXT');
		return dir;
	}

	test('differing live state previews and is not touched', async () => {
		const dir = scratchLegacy();
		const live = path.join(dir, '.swarm', 'context.md');

		const out = await handleRollbackCommand(dir, ['1']);

		expect(out).toContain('--confirm=');
		expect(out).toContain('context.md');
		expect(out).not.toContain('Rolled back to phase');
		expect(fs.readFileSync(live, 'utf-8')).toBe('LIVE-CONTEXT');
		expect(backupDirs(dir)).toEqual([]);
	});

	test('confirm token executes, gates the overwrite, and backs up prior live bytes', async () => {
		const dir = scratchLegacy();
		const live = path.join(dir, '.swarm', 'context.md');

		const preview = await handleRollbackCommand(dir, ['1']);
		const token = /--confirm=([A-Za-z0-9]+)/.exec(preview)?.[1];
		const out = await handleRollbackCommand(dir, ['1', `--confirm=${token}`]);

		expect(out).toContain('Rolled back to phase 1');
		expect(fs.readFileSync(live, 'utf-8')).toBe('CHECKPOINT-CONTEXT');
		expect(backupDirs(dir).length).toBe(1);
		expect(sentinelFound(dir, 'LIVE-CONTEXT')).toBe(true);
	});

	test('no differing live state keeps the single-call behavior', async () => {
		const dir = track(canonicalMkdtemp('rollback-legacy-clean-'));
		fs.mkdirSync(path.join(dir, '.swarm', 'checkpoints', 'phase-1'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(dir, '.swarm', 'checkpoints', 'manifest.json'),
			JSON.stringify({
				checkpoints: [
					{ phase: 1, label: 'kickoff', timestamp: '2026-01-01T00:00:00.000Z' },
				],
			}),
		);
		fs.writeFileSync(
			path.join(dir, '.swarm', 'checkpoints', 'phase-1', 'fresh.md'),
			'FRESH',
		);

		const out = await handleRollbackCommand(dir, ['1']);

		expect(out).toContain('Rolled back to phase 1');
		expect(out).not.toContain('--confirm=');
	});

	test('legacy phase path rejects --yes together with --confirm (#2976 F-7)', async () => {
		const dir = scratchLegacy();
		const live = path.join(dir, '.swarm', 'context.md');

		const out = await handleRollbackCommand(dir, [
			'1',
			'--yes',
			'--confirm=whatever',
		]);

		expect(out).toContain('not both');
		expect(out).not.toContain('Rolled back to phase');
		expect(fs.readFileSync(live, 'utf-8')).toBe('LIVE-CONTEXT');
	});
});
