import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/repro-check.sh',
);
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) safeRmRecursive(root);
});

function git(cwd: string, ...args: string[]): string {
	const proc = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	});
	if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
	return proc.stdout.toString().trim();
}

function makeRepo(): { repo: string; base: string } {
	const repo = canonicalMkdtemp('repro-check-cleanup-');
	roots.push(repo);
	git(repo, 'init', '-q', '-b', 'main');
	git(repo, 'config', 'user.email', 'trace@example.invalid');
	git(repo, 'config', 'user.name', 'Trace');
	fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'seed');
	return { repo, base: git(repo, 'rev-parse', 'HEAD') };
}

describe('repro-check.sh fallback cleanup (#2566)', () => {
	test('reports a bounded timeout and terminates the child before its late marker', async () => {
		const { repo, base } = makeRepo();
		const result = Bun.spawnSync({
			cmd: bashCommand(
				SCRIPT,
				'run',
				'--base',
				base,
				'--class',
				'PRESERVING',
				'--id',
				'C1',
				'--slug',
				'issue-2566',
				'--deps',
				'none',
				'--timeout',
				'1',
				'--',
				'bash',
				'-c',
				'sleep 2; printf leaked > cleanup-leaked.txt',
			),
			cwd: repo,
			env: { ...process.env, REPRO_CHECK_FORCE_FALLBACK: '1' },
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 15_000,
		});
		const out = result.stdout.toString();
		const err = result.stderr.toString();

		expect(result.exitCode, `${out}\n${err}`).toBe(6);
		expect(out).toContain('base:');
		expect(out).toContain('head:');
		expect(out).toMatch(/exit=124/);
		expect(out).toContain('result=TIMEOUT');

		// The marker is deliberately scheduled after the one-second watchdog
		// deadline. Waiting past that deadline makes this assert a surviving
		// child, not merely a promptly returned parent.
		await Bun.sleep(2_500);
		expect(fs.existsSync(path.join(repo, 'cleanup-leaked.txt'))).toBe(false);
	});
});
