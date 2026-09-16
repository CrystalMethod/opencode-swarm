import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/trace-check.sh',
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

describe('trace-check.sh CRLF fixture (#2566)', () => {
	test('accepts anchored phase-0 fields stored with CRLF line endings', () => {
		const repo = canonicalMkdtemp('trace-check-crlf-');
		roots.push(repo);
		git(repo, 'init', '-q', '-b', 'main');
		git(repo, 'config', 'user.email', 'trace@example.invalid');
		git(repo, 'config', 'user.name', 'Trace');
		fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'seed');
		const sha = git(repo, 'rev-parse', 'HEAD');
		const tree = git(repo, 'rev-parse', 'HEAD^{tree}');
		const trace = path.join(repo, '.agents', 'issue-traces', 'crlf-trace');
		fs.mkdirSync(path.join(trace, 'repro'), { recursive: true });
		const lines = [
			'# Trace State: crlf-trace',
			'protocol: 3.0.0',
			'phase: 0',
			'tier: S',
			'classification: VALID',
			'base-ref: main',
			`base-sha: ${sha}`,
			'freshness: synced',
			`phase0-tree-id: ${tree}`,
			`checkpoint-tree-id: ${tree}`,
			'handshake: ABSENT',
			'tools: none',
			'merge: not-applicable',
			'next-action: test',
			'',
			'## Gates',
			'| gate | verdict | reviewed-commit | tree-id | artifact |',
			'|---|---|---|---|---|',
			'',
		];
		fs.writeFileSync(path.join(trace, 'state.md'), `${lines.join('\r\n')}\r\n`);

		const proc = Bun.spawnSync({
			cmd: bashCommand(
				SCRIPT,
				'phase',
				'0',
				'--slug',
				'crlf-trace',
				'--trace-dir',
				trace,
			),
			cwd: repo,
			env: process.env,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 15_000,
		});

		expect(
			proc.exitCode,
			`${proc.stdout.toString()}\n${proc.stderr.toString()}`,
		).toBe(0);
	});
});
