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

function run(cwd: string, args: string[]) {
	const proc = Bun.spawnSync({
		cmd: bashCommand(SCRIPT, ...args),
		cwd,
		env: process.env,
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

describe('repro-check.sh FORMAT_ONLY amendment policy (#2566)', () => {
	test('does not accept a replay-skipping FORMAT_ONLY amendment for changed content', () => {
		const repo = canonicalMkdtemp('repro-check-format-only-');
		roots.push(repo);
		git(repo, 'init', '-q', '-b', 'main');
		git(repo, 'config', 'user.email', 'trace@example.invalid');
		git(repo, 'config', 'user.name', 'Trace');
		fs.writeFileSync(
			path.join(repo, 'check.sh'),
			'#!/usr/bin/env bash\necho original >&2\nexit 1\n',
		);
		fs.chmodSync(path.join(repo, 'check.sh'), 0o755);
		git(repo, 'add', 'check.sh');
		git(repo, 'commit', '-q', '-m', 'seed');
		const base = git(repo, 'rev-parse', 'HEAD');

		const initial = run(repo, [
			'checkpoint',
			'--slug',
			'issue-2566',
			'--id',
			'C1',
			'--argv',
			'bash check.sh',
			'--expect',
			'original',
			'--base',
			base,
			'check.sh',
		]);
		expect(initial.code, `${initial.out}\n${initial.err}`).toBe(0);

		fs.writeFileSync(
			path.join(repo, 'check.sh'),
			'#!/usr/bin/env bash\nexit 0\n',
		);
		fs.chmodSync(path.join(repo, 'check.sh'), 0o755);
		const amendment = run(repo, [
			'checkpoint',
			'--reason',
			'FORMAT_ONLY',
			'--slug',
			'issue-2566',
			'--id',
			'C1',
			'--argv',
			'bash check.sh',
			'--expect',
			'original',
			'--base',
			base,
			'check.sh',
		]);

		expect(amendment.code, `${amendment.out}\n${amendment.err}`).not.toBe(0);
	});
});
