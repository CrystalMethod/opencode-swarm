/**
 * Issue #2946: /swarm checkpoint restore (the command wrapper) passes the
 * two-step gate through to the tool sink and renders previews honestly.
 *
 * Drives the REAL handleCheckpointCommand with real git in scratch repos.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { handleCheckpointCommand } from '../../../src/commands/checkpoint';
import { checkpoint } from '../../../src/tools/checkpoint';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function git(args: string[], cwd: string): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

const scratchDirs: string[] = [];

async function scratchRepo(): Promise<{ dir: string; file: string }> {
	const dir = canonicalMkdtemp('checkpoint-cmd-');
	scratchDirs.push(dir);
	git(['init', '-q'], dir);
	git(['config', 'user.email', 'test@example.com'], dir);
	git(['config', 'user.name', 'Test'], dir);
	git(['config', 'commit.gpgsign', 'false'], dir);
	const file = path.join(dir, 'src.txt');
	fs.writeFileSync(file, 'committed-content-v1');
	git(['add', '.'], dir);
	git(['commit', '-q', '-m', 'init'], dir);
	const result = await checkpoint.execute({ action: 'save', label: 'gate' }, {
		directory: dir,
	} as ToolContext);
	if (!String(result).includes('"success": true')) {
		throw new Error(`checkpoint save failed: ${String(result)}`);
	}
	return { dir, file };
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

describe('/swarm checkpoint restore — two-step pass-through (#2946)', () => {
	test('dirty tree previews with a token instead of restoring', async () => {
		const { dir, file } = await scratchRepo();
		fs.writeFileSync(file, 'UNCOMMITTED-EDIT-MUST-SURVIVE');

		const out = await handleCheckpointCommand(dir, ['restore', 'gate']);

		expect(out).toContain('--confirm=');
		expect(out).toContain('Nothing was restored');
		expect(out).not.toContain('✓ Restored');
		expect(fs.readFileSync(file, 'utf-8')).toBe(
			'UNCOMMITTED-EDIT-MUST-SURVIVE',
		);
	});

	test('--yes confirms in one invocation and backs up', async () => {
		const { dir, file } = await scratchRepo();
		fs.writeFileSync(file, 'BACKUP-SENTINEL-CMD-YES');

		const out = await handleCheckpointCommand(dir, [
			'restore',
			'gate',
			'--yes',
		]);

		expect(out).toContain('✓ Restored to checkpoint: "gate"');
		expect(fs.readFileSync(file, 'utf-8')).toBe('committed-content-v1');
		expect(fs.existsSync(path.join(dir, '.swarm', 'rollback-backups'))).toBe(
			true,
		);
	});

	test('--confirm=<token> executes the previewed restore', async () => {
		const { dir, file } = await scratchRepo();
		fs.writeFileSync(file, 'PRECIOUS-EDIT-CMD');
		const preview = await handleCheckpointCommand(dir, ['restore', 'gate']);
		const token = /--confirm=([A-Za-z0-9]+)/.exec(preview)?.[1];
		expect(token).toBeTruthy();

		const out = await handleCheckpointCommand(dir, [
			'restore',
			'gate',
			`--confirm=${token}`,
		]);

		expect(out).toContain('✓ Restored to checkpoint: "gate"');
		expect(fs.readFileSync(file, 'utf-8')).toBe('committed-content-v1');
	});

	test('clean tree restores in one call with no token demanded', async () => {
		const { dir } = await scratchRepo();

		const out = await handleCheckpointCommand(dir, ['restore', 'gate']);

		expect(out).toContain('✓ Restored to checkpoint: "gate"');
		expect(out).not.toContain('--confirm=');
	});
});
