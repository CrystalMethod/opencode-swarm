/**
 * Issue #2946: the agent-reachable checkpoint tool restore is gated.
 *
 * Drives the REAL tool (src/tools/checkpoint.ts) with real git in scratch
 * repositories — no mocks. Also pins the source-order invariant (AC8): the
 * consumeConfirmToken call site must precede the git reset --hard call site.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
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

async function scratchRepo(): Promise<{
	dir: string;
	file: string;
	label: string;
}> {
	const dir = canonicalMkdtemp('checkpoint-gate-');
	scratchDirs.push(dir);
	git(['init', '-q'], dir);
	git(['config', 'user.email', 'test@example.com'], dir);
	git(['config', 'user.name', 'Test'], dir);
	git(['config', 'commit.gpgsign', 'false'], dir);
	const file = path.join(dir, 'src.txt');
	fs.writeFileSync(file, 'committed-content-v1');
	git(['add', '.'], dir);
	git(['commit', '-q', '-m', 'init'], dir);
	const label = 'agent-reachable';
	const result = await checkpoint.execute({ action: 'save', label }, {
		directory: dir,
	} as ToolContext);
	if (!String(result).includes('"success": true')) {
		throw new Error(`checkpoint save failed: ${String(result)}`);
	}
	return { dir, file, label };
}

function parse(result: unknown): Record<string, unknown> {
	const raw =
		typeof result === 'string' ? result : (result as { output: string }).output;
	return JSON.parse(raw) as Record<string, unknown>;
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

describe('checkpoint tool restore gate (#2946)', () => {
	test('no confirm_token on a dirty tree previews instead of resetting', async () => {
		const { dir, file, label } = await scratchRepo();
		fs.writeFileSync(file, 'UNCOMMITTED-EDIT-MUST-SURVIVE');

		const parsed = parse(
			await checkpoint.execute({ action: 'restore', label }, {
				directory: dir,
			} as ToolContext),
		);

		expect(parsed.success).toBe(false);
		expect(parsed.requires_confirm).toBe(true);
		expect(typeof parsed.confirm_token).toBe('string');
		expect(String(parsed.message)).toContain('confirm_token');
		expect(fs.readFileSync(file, 'utf-8')).toBe(
			'UNCOMMITTED-EDIT-MUST-SURVIVE',
		);
	});

	test('the sink-issued preview token executes at the sink (cross-surface mint confirm is covered by rollback-two-step)', async () => {
		const { dir, file, label } = await scratchRepo();
		fs.writeFileSync(file, 'PRECIOUS-UNCOMMITTED-EDIT');

		const preview = parse(
			await checkpoint.execute({ action: 'restore', label }, {
				directory: dir,
			} as ToolContext),
		);
		const token = preview.confirm_token as string;

		const executed = parse(
			await checkpoint.execute(
				{ action: 'restore', label, confirm_token: token },
				{ directory: dir } as ToolContext,
			),
		);

		expect(executed.success).toBe(true);
		expect(fs.readFileSync(file, 'utf-8')).toBe('committed-content-v1');
		expect(typeof executed.backup_dir).toBe('string');
		const backupRoot = path.join(dir, '.swarm', 'rollback-backups');
		expect(fs.existsSync(backupRoot)).toBe(true);
		let sentinelFound = false;
		const stack = [backupRoot];
		while (stack.length > 0 && !sentinelFound) {
			const current = stack.pop() as string;
			for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
				const p = path.join(current, entry.name);
				if (entry.isDirectory()) stack.push(p);
				else if (
					fs.readFileSync(p, 'utf-8').includes('PRECIOUS-UNCOMMITTED-EDIT')
				)
					sentinelFound = true;
			}
		}
		expect(sentinelFound).toBe(true);
	});

	test('clean tree executes directly without a token', async () => {
		const { dir, file, label } = await scratchRepo();

		const parsed = parse(
			await checkpoint.execute({ action: 'restore', label }, {
				directory: dir,
			} as ToolContext),
		);

		expect(parsed.success).toBe(true);
		expect(parsed.requires_confirm).toBeUndefined();
		expect(fs.readFileSync(file, 'utf-8')).toBe('committed-content-v1');
	});

	test('AC8 source-order: consumeConfirmToken( precedes the hard reset in handleRestore', () => {
		const source = fs.readFileSync(
			path.resolve(import.meta.dir, '../../../src/tools/checkpoint.ts'),
			'utf-8',
		);
		const consumeAt = source.indexOf('consumeConfirmToken(');
		const resetAt = source.indexOf("['reset', '--hard'");
		expect(consumeAt).toBeGreaterThan(-1);
		expect(resetAt).toBeGreaterThan(-1);
		expect(consumeAt).toBeLessThan(resetAt);
	});
});
