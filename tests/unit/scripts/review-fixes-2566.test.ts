import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand, resolveBash } from '../../helpers/bash';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TRACE_CHECK = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/trace-check.sh',
);
const REPRO_CHECK = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/repro-check.sh',
);
const TRACE_INIT = path.resolve(
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

function run(script: string, cwd: string, args: string[]) {
	const proc = Bun.spawnSync({
		cmd: bashCommand(script, ...args),
		cwd,
		env: process.env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 20_000,
	});
	return {
		code: proc.exitCode,
		out: proc.stdout.toString(),
		err: proc.stderr.toString(),
	};
}

function makeRepo(prefix = 'review-fixes-2566-'): string {
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

function state(slug: string, phase: string, tree: string): string {
	return [
		`# Trace State: ${slug}`,
		'protocol: 3.0.0',
		`phase: ${phase}`,
		'tier: L',
		'classification: VALID',
		'base-ref: main',
		`base-sha: ${tree}`,
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
	].join('\n');
}

function makeTrace(repo: string, slug = 'issue-2566', phase = '0'): string {
	const trace = path.join(repo, '.agents', 'issue-traces', slug);
	fs.mkdirSync(path.join(trace, 'repro'), { recursive: true });
	const tree = git(repo, 'rev-parse', 'HEAD^{tree}');
	fs.writeFileSync(path.join(trace, 'state.md'), state(slug, phase, tree));
	return trace;
}

function link(
	target: string,
	destination: string,
	kind: 'file' | 'dir' = 'dir',
) {
	fs.symlinkSync(
		target,
		destination,
		process.platform === 'win32' ? 'junction' : kind,
	);
}

function phase4Fixture(trace: string): void {
	fs.writeFileSync(
		path.join(trace, '02-reproduction.md'),
		[
			'| AC | class | check | argv | expect | pre-fix | post-fix | notes |',
			'| AC1 | DISCRIMINATING | C1 | command | failure | RED | GREEN | escape |',
		].join('\n'),
	);
	fs.writeFileSync(
		path.join(trace, '08-test-results.md'),
		[
			'## Regression Test',
			'run',
			'## Acceptance check results',
			'### Check C1',
			'run',
			'## Quality Checks',
			'run',
			'## Deferred-Work Scan',
			'scan-deferred: clean',
			'## Verification Reasoning',
			'run',
			'## Checkpoint verification',
			'run',
		].join('\n'),
	);
}

describe('issue-tracer 2566 review-fix containment', () => {
	test('rejects a state.md leaf symlink before reading it', () => {
		const repo = makeRepo();
		const trace = makeTrace(repo);
		const outside = canonicalMkdtemp('review-fixes-2566-state-target-');
		roots.push(outside);
		const outsideState = path.join(outside, 'state.md');
		fs.writeFileSync(outsideState, 'protocol: 3.0.0\n');
		fs.rmSync(path.join(trace, 'state.md'));
		link(outside, path.join(trace, 'state.md'));

		const result = run(TRACE_CHECK, repo, [
			'phase',
			'0',
			'--slug',
			'issue-2566',
		]);

		expect(result.code, `${result.out}\n${result.err}`).toBe(2);
		expect(fs.readFileSync(outsideState, 'utf8')).toBe('protocol: 3.0.0\n');
	});

	test('rejects a repro directory symlink before reading its manifest', () => {
		const repo = makeRepo();
		const trace = makeTrace(repo, 'issue-repro-dir', '4');
		phase4Fixture(trace);
		const outside = canonicalMkdtemp('review-fixes-2566-repro-target-');
		roots.push(outside);
		fs.writeFileSync(
			path.join(outside, 'checkpoint.manifest'),
			'# issue-tracer checkpoint manifest v1 rows=0\n',
		);
		fs.rmSync(path.join(trace, 'repro'), { recursive: true });
		link(outside, path.join(trace, 'repro'));

		const result = run(TRACE_CHECK, repo, [
			'phase',
			'4',
			'--slug',
			'issue-repro-dir',
		]);

		expect(result.code, `${result.out}\n${result.err}`).toBe(2);
		expect(
			fs.readFileSync(path.join(outside, 'checkpoint.manifest'), 'utf8'),
		).toBe('# issue-tracer checkpoint manifest v1 rows=0\n');
	});

	test('rejects a checkpoint.manifest leaf symlink before validation', () => {
		const repo = makeRepo();
		const trace = makeTrace(repo, 'issue-manifest-leaf');
		const outside = canonicalMkdtemp('review-fixes-2566-manifest-target-');
		roots.push(outside);
		const outsideManifest = path.join(outside, 'checkpoint.manifest');
		fs.writeFileSync(
			outsideManifest,
			'# issue-tracer checkpoint manifest v1 rows=0\n',
		);
		const manifest = path.join(trace, 'repro', 'checkpoint.manifest');
		link(outside, manifest);

		const result = run(REPRO_CHECK, repo, [
			'verify-checkpoint',
			'--slug',
			'issue-manifest-leaf',
		]);

		expect(result.code, `${result.out}\n${result.err}`).toBe(2);
		expect(fs.readFileSync(outsideManifest, 'utf8')).toBe(
			'# issue-tracer checkpoint manifest v1 rows=0\n',
		);
	});

	test('rejects a repro directory symlink before resolving checkpoint.manifest', () => {
		const repo = makeRepo();
		const trace = makeTrace(repo, 'issue-repro-verify');
		const outside = canonicalMkdtemp('review-fixes-2566-repro-verify-target-');
		roots.push(outside);
		fs.writeFileSync(
			path.join(outside, 'checkpoint.manifest'),
			'# issue-tracer checkpoint manifest v1 rows=0\n',
		);
		fs.rmSync(path.join(trace, 'repro'), { recursive: true });
		link(outside, path.join(trace, 'repro'));

		const result = run(REPRO_CHECK, repo, [
			'verify-checkpoint',
			'--slug',
			'issue-repro-verify',
		]);

		expect(result.code, `${result.out}\n${result.err}`).toBe(2);
	});

	test('rejects a symlinked approved-plan artifact before Phase 3 reads it', () => {
		const repo = makeRepo();
		const trace = makeTrace(repo, 'issue-approved-plan', '3');
		fs.writeFileSync(
			path.join(trace, '05-fix-plan.md'),
			'## Selected Fix\nx\n## Candidate Fixes\nx\n## Impact Analysis\nx\n## Anticipated Defect-Class Sweep (Phase 4.2)\nx\n',
		);
		fs.writeFileSync(
			path.join(trace, '06-critic-review.md'),
			'## Reviewed SHA / diff hash\nx\n## Verdict\nAPPROVE\n## Check replay\nx\n## Round 1\nx\n',
		);
		const outside = canonicalMkdtemp('review-fixes-2566-plan-target-');
		roots.push(outside);
		const outsidePlan = path.join(outside, '07-approved-plan.md');
		fs.writeFileSync(outsidePlan, 'outside plan\n');
		link(outside, path.join(trace, '07-approved-plan.md'));

		const result = run(TRACE_CHECK, repo, [
			'phase',
			'3',
			'--slug',
			'issue-approved-plan',
		]);
		expect(result.code, `${result.out}\n${result.err}`).toBe(2);
		expect(fs.readFileSync(outsidePlan, 'utf8')).toBe('outside plan\n');
	});
});

describe('repro-check.sh check-id validation (#2566)', () => {
	test('accepts C plus one or more ASCII digits and rejects traversal/malformed ids', () => {
		const repo = makeRepo('review-fixes-2566-id-');
		const trace = makeTrace(repo, 'issue-ids');
		const base = git(repo, 'rev-parse', 'HEAD');
		for (const id of ['C1', 'C123']) {
			const accepted = run(REPRO_CHECK, repo, [
				'checkpoint',
				'--slug',
				'issue-ids',
				'--id',
				id,
				'--argv',
				'command',
				'--expect',
				'-',
				'--base',
				base,
				'subject.txt',
			]);
			expect(accepted.code, `${accepted.out}\n${accepted.err}`).toBe(0);
		}

		const outside = path.join(
			path.dirname(repo),
			'review-fixes-2566-outside.log',
		);
		for (const id of [
			'C',
			'C1x',
			'C-1',
			'C1/../../review-fixes-2566-outside',
		]) {
			const rejected = run(REPRO_CHECK, repo, [
				'run',
				'--slug',
				'issue-ids',
				'--id',
				id,
				'--class',
				'PRESERVING',
				'--base',
				base,
				'--',
				'bash',
				'-c',
				'exit 0',
			]);
			expect(rejected.code, `${rejected.out}\n${rejected.err}`).toBe(2);
		}
		expect(fs.existsSync(outside)).toBe(false);
		fs.rmSync(trace, { recursive: true, force: true });
	});
});

describe('trace-init.sh old-Git fallback (#2566)', () => {
	test('proves the shim rejected --path-format before fallback succeeded', () => {
		const main = makeRepo('review-fixes-2566-old-git-');
		const parent = canonicalMkdtemp('review-fixes-2566-old-git-worktree-');
		roots.push(parent);
		const linked = path.join(parent, 'linked');
		git(main, 'worktree', 'add', '-q', '-b', 'review-old-git', linked);
		const realGit = Bun.which('git');
		if (!realGit) throw new Error('git is required for trace-init tests');
		const shimDir = canonicalMkdtemp('review-fixes-2566-old-git-shim-');
		roots.push(shimDir);
		const toShellPath = (value: string) =>
			process.platform === 'win32'
				? value
						.replace(
							/^([A-Za-z]):/,
							(_, drive: string) => `/${drive.toLowerCase()}`,
						)
						.replace(/\\/g, '/')
				: value;
		const shellRealGit = toShellPath(realGit);
		fs.writeFileSync(
			path.join(shimDir, 'git'),
			[
				'#!/usr/bin/env bash',
				'for arg in "$@"; do',
				'  case "$arg" in',
				'    --path-format=*)',
				'      printf "%s\\n" "$arg" > .trace-init-path-format-marker',
				'      echo "git: unrecognized option: $arg" >&2',
				'      exit 129',
				'      ;;',
				'  esac',
				'done',
				`exec "${shellRealGit}" "$@"`,
				'',
			].join('\n'),
		);
		fs.chmodSync(path.join(shimDir, 'git'), 0o755);
		const shellShimDir = toShellPath(shimDir);
		const env = {
			...process.env,
			PATH:
				process.platform === 'win32'
					? `${shellShimDir}:${process.env.PATH ?? ''}`
					: `${shellShimDir}${path.delimiter}${process.env.PATH ?? ''}`,
		};
		const command =
			process.platform === 'win32'
				? [
						resolveBash(),
						'-c',
						'export PATH="$1:/usr/bin:/bin"; exec /usr/bin/bash "$2" "$3"',
						'bash',
						shellShimDir,
						TRACE_INIT,
						'old-git-marker',
					]
				: bashCommand(TRACE_INIT, 'old-git-marker');
		const result = Bun.spawnSync({
			cmd: command,
			cwd: linked,
			env,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 20_000,
		});
		expect(
			result.exitCode,
			`${result.stdout.toString()}\n${result.stderr.toString()}`,
		).toBe(0);
		expect(
			fs.readFileSync(
				path.join(linked, '.trace-init-path-format-marker'),
				'utf8',
			),
		).toContain('--path-format=absolute');
	});
});
