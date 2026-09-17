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

		expect(amendment.code, `${amendment.out}\n${amendment.err}`).toBe(2);
		expect(amendment.err).toContain('invalid amendment reason');
	});

	test('verifies and recovers a legacy FORMAT_ONLY AMEND row without allowing a new one', () => {
		const repo = canonicalMkdtemp('repro-check-format-only-legacy-');
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
			'CHECK_WRONG',
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
		expect(amendment.code, `${amendment.out}\n${amendment.err}`).toBe(0);

		const manifest = path.join(
			repo,
			'.agents/issue-traces/issue-2566/repro/checkpoint.manifest',
		);
		// Prior v3 runs emitted FORMAT_ONLY on AMEND rows. The compatibility path
		// must keep those traces readable while the checkpoint parser rejects a
		// newly requested FORMAT_ONLY reason.
		const legacy = fs
			.readFileSync(manifest, 'utf8')
			.replace(/\tCHECK_WRONG\n$/, '\tFORMAT_ONLY\n');
		fs.writeFileSync(manifest, legacy);

		const verified = run(repo, ['verify-checkpoint', '--slug', 'issue-2566']);
		expect(verified.code, `${verified.out}\n${verified.err}`).toBe(0);
		expect(verified.out).toContain('OK check.sh (C1)');

		const recovered = run(repo, [
			'checkpoint',
			'--reason',
			'CHECK_WRONG',
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
		expect(recovered.code, `${recovered.out}\n${recovered.err}`).toBe(0);
	});
});
