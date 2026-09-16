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

function makeRepo(): { repo: string; trace: string; tree: string } {
	const repo = canonicalMkdtemp('trace-check-reverse-manifest-');
	roots.push(repo);
	git(repo, 'init', '-q', '-b', 'main');
	git(repo, 'config', 'user.email', 'trace@example.invalid');
	git(repo, 'config', 'user.name', 'Trace');
	fs.writeFileSync(path.join(repo, 'subject.txt'), 'seed\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'seed');
	const tree = git(repo, 'rev-parse', 'HEAD^{tree}');
	const trace = path.join(repo, '.agents', 'issue-traces', 'issue-2566');
	fs.mkdirSync(path.join(trace, 'repro'), { recursive: true });
	const head = git(repo, 'rev-parse', 'HEAD');
	const sha = 'a'.repeat(40);
	fs.writeFileSync(
		path.join(trace, 'state.md'),
		[
			'# Trace State: issue-2566',
			'protocol: 3.0.0',
			'phase: 4',
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
			'## Gates',
			'| gate | verdict | reviewed-commit | tree-id | artifact |',
			'|---|---|---|---|---|',
			'',
		].join('\n'),
	);
	fs.writeFileSync(
		path.join(trace, '01-issue-summary.md'),
		[
			'## Source',
			'x',
			'## Observed Behavior',
			'x',
			'## Expected Behavior',
			'x',
			'## Acceptance Criteria',
			'- [ ] AC1: every executable check is manifested',
			'## Classification',
			'VALID',
			'## Related Issues',
			'x',
		].join('\n'),
	);
	fs.writeFileSync(
		path.join(trace, '02-reproduction.md'),
		[
			'## Commands Tried',
			'command',
			'## Reproduction Verdict',
			'red',
			'| AC | class | check | argv | expect | pre-fix | post-fix | notes |',
			'| AC1 | DISCRIMINATING | C1 | trace-check | nonzero | RED | GREEN | reverse manifest |',
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
	fs.writeFileSync(
		path.join(trace, 'repro', 'checkpoint.manifest'),
		'# issue-tracer checkpoint manifest v1 rows=0\n',
	);
	return { repo, trace, tree };
}

describe('trace-check.sh reverse manifest completeness (#2566)', () => {
	test('phase 4 rejects an executable acceptance row missing from the manifest', () => {
		const { repo } = makeRepo();
		const result = run(repo, ['phase', '4', '--slug', 'issue-2566']);

		expect(result.code, `${result.out}\n${result.err}`).not.toBe(0);
		expect(`${result.out}\n${result.err}`).toMatch(/manifest|C1/i);
	});
});
