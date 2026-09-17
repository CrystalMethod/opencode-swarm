import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const REPRO_CHECK = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/repro-check.sh',
);
const TRACE_CHECK = path.resolve(
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

function run(script: string, cwd: string, args: string[]) {
	const proc = Bun.spawnSync({
		cmd: bashCommand(script, ...args),
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

function makeRepo(prefix = 'issue-tracer-hardening-'): string {
	const repo = canonicalMkdtemp(prefix);
	roots.push(repo);
	git(repo, 'init', '-q', '-b', 'main');
	git(repo, 'config', 'user.email', 'trace@example.invalid');
	git(repo, 'config', 'user.name', 'Trace');
	fs.writeFileSync(path.join(repo, 'subject.txt'), 'seed\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'seed');
	return repo;
}

function makeTrace(repo: string, slug: string, phase = '0'): string {
	const trace = path.join(repo, '.agents', 'issue-traces', slug);
	fs.mkdirSync(path.join(trace, 'repro'), { recursive: true });
	const head = git(repo, 'rev-parse', 'HEAD');
	const tree = git(repo, 'rev-parse', 'HEAD^{tree}');
	fs.writeFileSync(
		path.join(trace, 'state.md'),
		[
			`# Trace State: ${slug}`,
			'protocol: 3.0.0',
			`phase: ${phase}`,
			'tier: L',
			'classification: VALID',
			'base-ref: main',
			`base-sha: ${head}`,
			'freshness: synced',
			`phase0-tree-id: ${tree}`,
			`checkpoint-tree-id: ${tree}`,
			'handshake: ABSENT',
			'tools: none',
			'merge: not-applicable',
			'next-action: test',
			'',
		].join('\n'),
	);
	return trace;
}

describe('issue-tracer v3 hardening coverage', () => {
	test('phase 4 invokes the non-executable repro-check helper through bash', () => {
		const source = fs.readFileSync(TRACE_CHECK, 'utf8');
		const phase4Start = source.indexOf('phase4() {');
		const phase42Start = source.indexOf('phase42() {', phase4Start);
		expect(phase4Start).toBeGreaterThanOrEqual(0);
		expect(phase42Start).toBeGreaterThan(phase4Start);
		const phase4 = source.slice(phase4Start, phase42Start);

		// Before this regression fix, phase 4 executed repro-check.sh directly;
		// its repository mode is 100644, so POSIX hosts returned EACCES/126.
		expect(phase4).toContain(
			'bash "$script_dir/repro-check.sh" verify-semantics',
		);
		expect(phase4).toContain(
			'bash "$script_dir/repro-check.sh" verify-checkpoint',
		);
		expect(phase4).not.toContain(
			'if "$script_dir/repro-check.sh" verify-semantics',
		);
		expect(phase4).not.toContain(
			'if "$script_dir/repro-check.sh" verify-checkpoint',
		);
	}, 30_000);

	test('accepts both default and explicit in-root trace directories', () => {
		const repo = makeRepo();
		makeTrace(repo, 'issue-default');
		const defaultResult = run(TRACE_CHECK, repo, [
			'phase',
			'0',
			'--slug',
			'issue-default',
		]);
		expect(
			defaultResult.code,
			`${defaultResult.out}\n${defaultResult.err}`,
		).toBe(0);

		const explicit = makeTrace(repo, 'issue-explicit');
		const explicitResult = run(TRACE_CHECK, repo, [
			'phase',
			'0',
			'--slug',
			'issue-explicit',
			'--trace-dir',
			explicit,
		]);
		expect(
			explicitResult.code,
			`${explicitResult.out}\n${explicitResult.err}`,
		).toBe(0);
	}, 30_000);

	test('phase 4 rejects a partial non-empty manifest missing an executable id', () => {
		const repo = makeRepo();
		const trace = makeTrace(repo, 'issue-partial', '4');
		fs.writeFileSync(
			path.join(trace, '02-reproduction.md'),
			[
				'## Acceptance checks',
				'| AC | class | check | argv | expect | pre-fix | post-fix | notes |',
				'| AC1 | DISCRIMINATING | C1 | cmd | fail | RED | GREEN | first |',
				'| AC2 | PRESERVING | C2 | cmd | - | GREEN | GREEN | second |',
			].join('\n'),
		);
		fs.writeFileSync(
			path.join(trace, '08-test-results.md'),
			[
				'## Regression Test',
				'x',
				'## Acceptance check results',
				'### Check C1',
				'x',
				'## Quality Checks',
				'x',
				'## Deferred-Work Scan',
				'scan-deferred: clean',
				'## Verification Reasoning',
				'x',
				'## Checkpoint verification',
				'x',
			].join('\n'),
		);
		const blob = git(repo, 'hash-object', 'subject.txt');
		const head = git(repo, 'rev-parse', 'HEAD');
		fs.writeFileSync(
			path.join(trace, 'repro', 'checkpoint.manifest'),
			`# issue-tracer checkpoint manifest v1 rows=1\n1\tCHECKPOINT\tsubject.txt\t${blob}\t100644\tC1\tcmd\t-\t${head}\t-\n`,
		);

		const result = run(TRACE_CHECK, repo, [
			'phase',
			'4',
			'--slug',
			'issue-partial',
		]);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL check-block-C2');
		expect(result.out).toContain('FAIL manifest-check-C2');
	}, 30_000);

	test('verify-checkpoint rejects a hand-edited FORMAT_ONLY reason', () => {
		const repo = makeRepo();
		const trace = makeTrace(repo, 'issue-manifest');
		const base = git(repo, 'rev-parse', 'HEAD');
		const checkpoint = run(REPRO_CHECK, repo, [
			'checkpoint',
			'--slug',
			'issue-manifest',
			'--id',
			'C1',
			'--argv',
			'bash check.sh',
			'--expect',
			'-',
			'--base',
			base,
			'subject.txt',
		]);
		expect(checkpoint.code, `${checkpoint.out}\n${checkpoint.err}`).toBe(0);
		const manifest = path.join(trace, 'repro', 'checkpoint.manifest');
		const original = fs.readFileSync(manifest, 'utf8');
		fs.writeFileSync(
			manifest,
			original.replace(/\t-\r?\n$/, '\tFORMAT_ONLY\n'),
		);

		const result = run(REPRO_CHECK, repo, [
			'verify-checkpoint',
			'--slug',
			'issue-manifest',
		]);
		expect(result.code).toBe(2);
		expect(result.err).toContain('invalid reason');
	}, 30_000);
});
