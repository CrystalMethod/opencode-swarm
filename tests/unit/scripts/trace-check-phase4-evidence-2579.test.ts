import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/trace-check.sh',
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

test('phase 4 rejects a fabricated replay block without base/head logs', () => {
	const repo = canonicalMkdtemp('trace-check-phase4-evidence-');
	roots.push(repo);
	git(repo, 'init', '-q', '-b', 'main');
	git(repo, 'config', 'user.email', 'trace@example.invalid');
	git(repo, 'config', 'user.name', 'Trace');
	fs.writeFileSync(path.join(repo, 'subject.txt'), 'base\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'base');
	const head = git(repo, 'rev-parse', 'HEAD');
	const tree = git(repo, 'rev-parse', 'HEAD^{tree}');
	const blob = git(repo, 'hash-object', path.join(repo, 'subject.txt'));
	const trace = path.join(repo, '.agents', 'issue-traces', 'issue-1');
	fs.mkdirSync(path.join(trace, 'repro'), { recursive: true });
	fs.writeFileSync(
		path.join(trace, 'state.md'),
		`# Trace State: issue-1\nprotocol: 3.0.0\nphase: 4\ntier: S\nclassification: VALID\nbase-ref: main\nbase-sha: ${head}\nfreshness: synced\nphase0-tree-id: ${tree}\ncheckpoint-tree-id: ${tree}\nhandshake: MATCH\ntools: none\nmerge: AWAITING_USER_APPROVAL\nnext-action: test\n\n## Gates\n| gate | verdict | reviewed-commit | tree-id | artifact |\n|---|---|---|---|---|\n`,
	);
	fs.writeFileSync(
		path.join(trace, '01-issue-summary.md'),
		'## Source\nx\n## Observed Behavior\nx\n## Expected Behavior\nx\n## Acceptance Criteria\n- [ ] AC1: fixed\n## Classification\nVALID\n## Related Issues\nx\n',
	);
	fs.writeFileSync(
		path.join(trace, '02-reproduction.md'),
		`## Commands Tried\nx\n## Reproduction Verdict\nred\n## Acceptance checks\n| AC | class | check | argv | expect | pre-fix | post-fix | notes |\n|---|---|---|---|---|---|---|---|\n| AC1 | DISCRIMINATING | C1 | cmd | fail | RED | GREEN | replay |\n## Red checkpoint\ncheckpoint-tree-id: ${tree}\n`,
	);
	fs.writeFileSync(
		path.join(trace, 'repro', 'checkpoint.manifest'),
		`# issue-tracer checkpoint manifest v1 rows=1\n1\tCHECKPOINT\tsubject.txt\t${blob}\t100644\tC1\tcmd\tfail\t${head}\t-\n`,
	);
	fs.writeFileSync(
		path.join(trace, '08-test-results.md'),
		`## Regression Test\nrun\n## Acceptance check results\n### Check C1 (DISCRIMINATING)\n- base: ${head} exit=1 result=RED log=repro/C1.base.log\n- head: ${head} exit=0 result=GREEN log=repro/C1.head.log\n- argv: cmd\n- expect: fail\n- verdict: PASS\n## Quality Checks\nrun\n## Deferred-Work Scan\nscan-deferred: clean\n## Verification Reasoning\nrun\n## Checkpoint verification\nrun\n`,
	);

	const proc = Bun.spawnSync({
		cmd: bashCommand(SCRIPT, 'phase', '4', '--slug', 'issue-1'),
		cwd: repo,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	const output = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
	expect(proc.exitCode, output).toBe(1);
	expect(output).toContain('FAIL base-log-C1');
}, 30_000);
