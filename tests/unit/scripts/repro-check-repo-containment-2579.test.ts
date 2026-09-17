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

test.skipIf(process.platform === 'win32')(
	'rejects checkpoint and verify paths that resolve through a repository symlink',
	() => {
		const repo = canonicalMkdtemp('repro-check-repo-link-');
		const outside = canonicalMkdtemp('repro-check-repo-link-target-');
		roots.push(repo, outside);
		git(repo, 'init', '-q', '-b', 'main');
		git(repo, 'config', 'user.email', 'trace@example.invalid');
		git(repo, 'config', 'user.name', 'Trace');
		fs.writeFileSync(path.join(repo, 'subject.txt'), 'base\n');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'base');
		const base = git(repo, 'rev-parse', 'HEAD');
		const trace = path.join(repo, '.agents/issue-traces/issue-1');
		fs.mkdirSync(path.join(trace, 'repro'), { recursive: true });
		fs.writeFileSync(
			path.join(trace, 'repro', 'checkpoint.manifest'),
			'# issue-tracer checkpoint manifest v1 rows=0\n',
		);
		fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');
		fs.symlinkSync(outside, path.join(repo, 'linked'), 'dir');

		const proc = Bun.spawnSync({
			cmd: bashCommand(
				SCRIPT,
				'checkpoint',
				'--base',
				base,
				'--id',
				'C1',
				'--slug',
				'issue-1',
				'--trace-dir',
				trace,
				'--argv',
				'cat',
				'--expect',
				'outside',
				'--',
				'linked/secret.txt',
			),
			cwd: repo,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 30_000,
		});

		expect(proc.exitCode, proc.stderr.toString()).toBe(2);
		expect(proc.stderr.toString()).toContain('regular in-repository file');
		expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe(
			'outside\n',
		);
		expect(
			fs.readFileSync(path.join(trace, 'repro', 'checkpoint.manifest'), 'utf8'),
		).toContain('rows=0');

		const run = Bun.spawnSync({
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
				'--copy',
				'linked/secret.txt',
				'--',
				'cat',
				'linked/secret.txt',
			),
			cwd: repo,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 30_000,
		});
		expect(run.exitCode, run.stderr.toString()).toBe(2);
		expect(run.stderr.toString()).toContain('without symlink components');

		const subjectBlob = git(
			repo,
			'hash-object',
			path.join(repo, 'subject.txt'),
		);
		fs.writeFileSync(
			path.join(trace, 'repro', 'checkpoint.manifest'),
			`# issue-tracer checkpoint manifest v1 rows=1\n1\tCHECKPOINT\tlinked/secret.txt\t${subjectBlob}\t100644\tC1\tcat\toutside\t${base}\t-\n`,
		);
		const verify = Bun.spawnSync({
			cmd: bashCommand(
				SCRIPT,
				'verify-checkpoint',
				'--slug',
				'issue-1',
				'--trace-dir',
				trace,
			),
			cwd: repo,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 30_000,
		});
		expect(verify.exitCode, verify.stderr.toString()).toBe(1);
		expect(verify.stdout.toString()).toContain('CHANGED linked/secret.txt');
	},
	30_000,
);
