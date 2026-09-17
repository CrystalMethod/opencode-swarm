import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/repro-check.sh',
);
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
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

test.skipIf(process.platform === 'win32')(
	'rejects a dangling repro/ symlink before mkdir can follow it',
	() => {
		const repo = canonicalMkdtemp('repro-check-dangling-escape-');
		const outside = canonicalMkdtemp('repro-check-dangling-target-');
		roots.push(repo, outside);
		git(repo, 'init', '-q', '-b', 'main');
		git(repo, 'config', 'user.email', 'trace@example.invalid');
		git(repo, 'config', 'user.name', 'Trace');
		fs.writeFileSync(path.join(repo, 'check.sh'), '#!/usr/bin/env bash\n');
		fs.chmodSync(path.join(repo, 'check.sh'), 0o755);
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'base');
		const base = git(repo, 'rev-parse', 'HEAD');
		const trace = path.join(repo, '.agents/issue-traces/issue-1');
		fs.mkdirSync(trace, { recursive: true });
		fs.symlinkSync(
			path.join(outside, 'does-not-exist'),
			path.join(trace, 'repro'),
			'dir',
		);

		const proc = Bun.spawnSync({
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
				'issue-1',
				'--deps',
				'none',
				'--trace-dir',
				trace,
				'--',
				'bash',
				'check.sh',
			),
			cwd: repo,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 30_000,
		});

		expect(proc.exitCode, proc.stderr.toString()).toBe(2);
		expect(proc.stderr.toString()).toMatch(
			/refusing|must be inside \.agents\/issue-traces/,
		);
		expect(fs.existsSync(path.join(outside, 'does-not-exist'))).toBe(false);
	},
	30_000,
);
