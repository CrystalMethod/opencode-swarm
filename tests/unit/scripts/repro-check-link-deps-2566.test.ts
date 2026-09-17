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
		timeout: 30_000,
	});
	return {
		code: proc.exitCode,
		out: proc.stdout.toString(),
		err: proc.stderr.toString(),
	};
}

function makeRepo(): { repo: string; base: string } {
	const repo = canonicalMkdtemp('repro-check-link-deps-');
	roots.push(repo);
	git(repo, 'init', '-q', '-b', 'main');
	git(repo, 'config', 'user.email', 'trace@example.invalid');
	git(repo, 'config', 'user.name', 'Trace');
	fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
	git(repo, 'add', 'README.md');
	git(repo, 'commit', '-q', '-m', 'seed');
	const base = git(repo, 'rev-parse', 'HEAD');
	fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
	fs.writeFileSync(
		path.join(repo, 'node_modules', 'fixture-marker.txt'),
		'present\n',
	);
	return { repo, base };
}

function checkArgs(base: string, deps: 'link' | 'none') {
	return [
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
		deps,
		'--timeout',
		'5',
		'--',
		'bash',
		'-c',
		'test -f node_modules/fixture-marker.txt',
	];
}

describe('repro-check.sh dependency-link portability (#2566)', () => {
	test('link mode creates a usable dependency junction, while none mode does not', () => {
		const { repo, base } = makeRepo();
		const linked = run(repo, checkArgs(base, 'link'));
		expect(linked.code, `${linked.out}\n${linked.err}`).toBe(0);
		expect(linked.out).toContain('base:');
		expect(linked.out).toContain('result=GREEN');

		const none = run(repo, checkArgs(base, 'none'));
		expect(none.code).toBe(5);
		expect(none.out).toContain('base:');
		expect(none.out).toContain('result=FAIL');
		expect(none.out).toContain('head:');
		expect(none.out).toContain('result=GREEN');
	});
});
