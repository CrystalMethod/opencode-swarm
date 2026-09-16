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

function makeRepo(prefix: string): string {
	const repo = canonicalMkdtemp(prefix);
	roots.push(repo);
	git(repo, 'init', '-q', '-b', 'main');
	git(repo, 'config', 'user.email', 'trace@example.invalid');
	git(repo, 'config', 'user.name', 'Trace');
	fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'seed');
	return repo;
}

function writePhase0State(trace: string, crlf = false): void {
	const lineEnding = crlf ? '\r\n' : '\n';
	const sha = 'a'.repeat(40);
	const body = [
		'# Trace State: issue-2566',
		'protocol: 3.0.0',
		'phase: 0',
		'tier: L',
		'classification: VALID',
		'base-ref: main',
		`base-sha: ${sha}`,
		'freshness: synced',
		`phase0-tree-id: ${sha}`,
		`checkpoint-tree-id: ${sha}`,
		'handshake: ABSENT',
		'tools: none',
		'merge: not-applicable',
		'next-action: test',
		'',
		'## Gates',
		'| gate | verdict | reviewed-commit | tree-id | artifact |',
		'|---|---|---|---|---|',
		'',
	].join(lineEnding);
	fs.writeFileSync(path.join(trace, 'state.md'), body);
}

function makeTrace(repo: string, slug: string): string {
	const trace = path.join(repo, '.agents', 'issue-traces', slug);
	fs.mkdirSync(path.join(trace, 'repro'), { recursive: true });
	writePhase0State(trace);
	return trace;
}

describe('trace-check.sh trace-dir containment (#2566)', () => {
	test('rejects a valid trace state supplied outside the project trace root', () => {
		const repo = makeRepo('trace-check-containment-outside-');
		const outside = canonicalMkdtemp('trace-check-outside-');
		roots.push(outside);
		const trace = makeTrace(outside, 'outside-trace');

		const result = run(repo, [
			'phase',
			'0',
			'--slug',
			'issue-2566',
			'--trace-dir',
			trace,
		]);

		expect(result.code, `${result.out}\n${result.err}`).toBe(2);
	});

	test('rejects a trace-root symlink that resolves outside the project', () => {
		const repo = makeRepo('trace-check-containment-symlink-');
		const outside = canonicalMkdtemp('trace-check-symlink-target-');
		roots.push(outside);
		const outsideTrace = makeTrace(outside, 'escaped-trace');
		const link = path.join(repo, '.agents', 'issue-traces', 'escaped-trace');
		fs.mkdirSync(path.dirname(link), { recursive: true });
		fs.symlinkSync(
			outsideTrace,
			link,
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		const result = run(repo, [
			'phase',
			'0',
			'--slug',
			'escaped-trace',
			'--trace-dir',
			link,
		]);

		expect(result.code, `${result.out}\n${result.err}`).toBe(2);
	});
});
