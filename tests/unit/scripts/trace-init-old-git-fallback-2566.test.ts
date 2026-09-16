import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand, resolveBash } from '../../helpers/bash';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/trace-init.sh',
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

function runOldGit(cwd: string, shimDir: string) {
	const env = {
		...process.env,
		PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
	};
	const command =
		process.platform === 'win32'
			? [resolveBash(), SCRIPT, 'old-git-fallback-2566']
			: bashCommand(SCRIPT, 'old-git-fallback-2566');
	const proc = Bun.spawnSync({
		cmd: command,
		cwd,
		env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 15_000,
	});
	return {
		code: proc.exitCode,
		out: proc.stdout.toString(),
		err: proc.stderr.toString(),
	};
}

function makeOldGitShim(): string {
	const realGit = Bun.which('git');
	if (!realGit) throw new Error('git is required for trace-init tests');
	const shimDir = canonicalMkdtemp('trace-init-old-git-shim-');
	roots.push(shimDir);
	fs.writeFileSync(
		path.join(shimDir, 'git'),
		[
			'#!/usr/bin/env bash',
			'for arg in "$@"; do',
			'  case "$arg" in',
			'    --path-format=*)',
			'      echo "git: unrecognized option: $arg" >&2',
			'      exit 129',
			'      ;;',
			'  esac',
			'done',
			`exec "${realGit}" "$@"`,
			'',
		].join('\n'),
	);
	fs.chmodSync(path.join(shimDir, 'git'), 0o755);
	return shimDir;
}

function makeRepo(): { main: string; linked: string } {
	const main = canonicalMkdtemp('trace-init-old-git-main-');
	const parent = canonicalMkdtemp('trace-init-old-git-worktree-');
	roots.push(main, parent);
	git(main, 'init', '-q', '-b', 'main');
	git(main, 'config', 'user.email', 'trace@example.invalid');
	git(main, 'config', 'user.name', 'Trace');
	fs.writeFileSync(path.join(main, 'README.md'), 'seed\n');
	git(main, 'add', '-A');
	git(main, 'commit', '-q', '-m', 'seed');
	const linked = path.join(parent, 'linked');
	git(main, 'worktree', 'add', '-q', '-b', 'old-git-fallback', linked);
	return { main, linked };
}

describe('trace-init.sh old Git fallback (#2566)', () => {
	test('uses the shared common Git info directory when --path-format is unavailable', () => {
		const { main, linked } = makeRepo();
		const shim = makeOldGitShim();
		const result = runOldGit(linked, shim);

		expect(result.code, `${result.out}\n${result.err}`).toBe(0);
		expect(result.err).not.toContain('unrecognized option');
		expect(result.err).not.toContain('could not resolve the git directory');
		expect(
			fs.readFileSync(path.join(main, '.git', 'info', 'exclude'), 'utf8'),
		).toContain('.agents/issue-traces/');
		const privateExclude = path.join(
			main,
			'.git',
			'worktrees',
			'linked',
			'info',
			'exclude',
		);
		expect(fs.existsSync(privateExclude)).toBe(false);
	});
});
