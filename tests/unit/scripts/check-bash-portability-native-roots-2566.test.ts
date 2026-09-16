import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main } from '../../../scripts/check-bash-portability';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function git(cwd: string, ...args: string[]): void {
	const proc = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	});
	if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
}

describe('check-bash-portability native skill roots (#2566)', () => {
	test('discovers direct and nested shell files in every native skill tree', async () => {
		const repo = canonicalMkdtemp('bash-portability-native-roots-');
		try {
			git(repo, 'init', '-q', '-b', 'main');
			git(repo, 'config', 'user.email', 'trace@example.invalid');
			git(repo, 'config', 'user.name', 'Trace');
			fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
			git(repo, 'add', 'README.md');
			git(repo, 'commit', '-q', '-m', 'seed');

			const files = [
				'.claude/skills/graphify/install-hook-guard.sh',
				'.agents/skills/issue-tracer/nested/deep-check.sh',
				'.opencode/skills/issue-tracer/scripts/known-check.sh',
				'tests/fixtures/ignored-check.sh',
			];
			for (const file of files) {
				const target = path.join(repo, file);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, 'declare -A forbidden=()\n');
			}

			const output: string[] = [];
			const originalLog = console.log;
			console.log = (...args: unknown[]) => output.push(args.join(' '));
			let exitCode: number;
			try {
				exitCode = await main(repo);
			} finally {
				console.log = originalLog;
			}

			expect(exitCode!).toBe(1);
			const report = output.join('\n');
			expect(report).toContain('.claude/skills/graphify/install-hook-guard.sh');
			expect(report).toContain(
				'.agents/skills/issue-tracer/nested/deep-check.sh',
			);
			expect(report).toContain(
				'.opencode/skills/issue-tracer/scripts/known-check.sh',
			);
			expect(report).not.toContain('tests/fixtures/ignored-check.sh');
		} finally {
			safeRmRecursive(repo);
		}
	});
});
