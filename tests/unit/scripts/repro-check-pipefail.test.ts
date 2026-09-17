import { afterEach, describe, expect, test } from 'bun:test';
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
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
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

function runGeneratedWithPipefail(cwd: string, body: string, args: string[]) {
	const launcher = path.join(cwd, 'pipefail-launcher.sh');
	fs.writeFileSync(
		launcher,
		[
			'#!/usr/bin/env bash',
			'set -o pipefail',
			// Generate the large value in Bash rather than passing it through the
			// Windows command line, whose argument limit is much smaller.
			'bad="$(awk \'BEGIN { printf "%c", 27; for (i = 0; i < 100000; i++) printf "x" }\')"',
			body,
			'',
		].join('\n'),
	);
	fs.chmodSync(launcher, 0o755);
	const proc = Bun.spawnSync({
		cmd: bashCommand(launcher, SCRIPT, ...args),
		cwd,
		env: process.env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	return {
		code: proc.exitCode,
		out: proc.stdout.toString(),
		err: proc.stderr.toString(),
	};
}

function repo(): string {
	const value = canonicalMkdtemp('repro-check-pipefail-');
	roots.push(value);
	git(value, 'init', '-q', '-b', 'main');
	git(value, 'config', 'user.email', 'trace@example.invalid');
	git(value, 'config', 'user.name', 'Trace');
	fs.writeFileSync(
		path.join(value, 'check.sh'),
		'#!/usr/bin/env bash\nexit 1\n',
	);
	fs.chmodSync(path.join(value, 'check.sh'), 0o755);
	fs.writeFileSync(path.join(value, 'subject.txt'), 'base\n');
	git(value, 'add', '-A');
	git(value, 'commit', '-q', '-m', 'base');
	return value;
}

describe('repro-check.sh control validation under inherited pipefail', () => {
	test('rejects large control-bearing expectations, argv, and paths', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		let result = runGeneratedWithPipefail(
			worktree,
			'exec bash -o pipefail "$1" run --base "$2" --class DISCRIMINATING --id C1 --slug issue-1 --deps none --expect "$bad" -- bash check.sh',
			[base],
		);
		expect(result.code).toBe(2);
		expect(result.err).toContain('--expect cannot contain control bytes');

		result = runGeneratedWithPipefail(
			worktree,
			'exec bash -o pipefail "$1" checkpoint --slug issue-1 --id C1 --argv "$bad" --expect - --base "$2" subject.txt',
			[base],
		);
		expect(result.code).toBe(2);
		expect(result.err).toContain(
			'manifest fields cannot contain control bytes',
		);

		result = runGeneratedWithPipefail(
			worktree,
			'exec bash -o pipefail "$1" checkpoint --slug issue-1 --id C2 --argv "bash check.sh" --expect - --base "$2" "subject${bad}.txt"',
			[base],
		);
		expect(result.code).toBe(2);
		expect(result.err).toContain(
			'checkpoint path cannot contain control bytes',
		);
	});
});
