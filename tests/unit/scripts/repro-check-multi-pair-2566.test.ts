/**
 * Regression coverage for checkpoint identity when multiple acceptance checks
 * freeze the same file (issue #2566 follow-up).
 *
 * The manifest identity is (path, check id), not path alone.  A checkpoint
 * tree can collapse same-path rows only when their effective blobs agree;
 * otherwise replay must fail closed instead of using path-only last-writer-
 * wins behavior.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
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

function run(script: string, cwd: string, args: string[]) {
	const proc = Bun.spawnSync({
		cmd: bashCommand(script, ...args),
		cwd,
		env: { ...process.env, REPRO_CHECK_FORCE_FALLBACK: '0' },
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

function repo(prefix = 'repro-multi-pair-2566-'): string {
	const value = canonicalMkdtemp(prefix);
	roots.push(value);
	git(value, 'init', '-q', '-b', 'main');
	git(value, 'config', 'user.email', 'trace@example.invalid');
	git(value, 'config', 'user.name', 'Trace');
	fs.writeFileSync(path.join(value, 'subject.txt'), 'base\n');
	git(value, 'add', '-A');
	git(value, 'commit', '-q', '-m', 'base');
	return value;
}

function checkpoint(
	repoDir: string,
	base: string,
	checkId: string,
	reason?: string,
) {
	return checkpointPaths(repoDir, base, checkId, ['subject.txt'], reason);
}

function checkpointPaths(
	repoDir: string,
	base: string,
	checkId: string,
	paths: string[],
	reason?: string,
) {
	return run(REPRO_CHECK, repoDir, [
		'checkpoint',
		'--slug',
		'issue-1',
		...(reason ? ['--reason', reason] : []),
		'--id',
		checkId,
		'--argv',
		`bash ${checkId}.sh`,
		'--expect',
		'-',
		'--base',
		base,
		...paths,
	]);
}

function manifestFile(repoDir: string): string {
	return path.join(
		repoDir,
		'.agents/issue-traces/issue-1/repro/checkpoint.manifest',
	);
}

function rows(repoDir: string): string[][] {
	return fs
		.readFileSync(manifestFile(repoDir), 'utf8')
		.trimEnd()
		.split('\n')
		.slice(1)
		.map((line) => line.split('\t'));
}

describe('repro-check.sh multi-check same-path identity (F2566-MP)', () => {
	test('deduplicates multi-file checkpoint semantics by check id (F2813-2)', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		fs.writeFileSync(path.join(worktree, 'other.txt'), 'other\n');

		expect(
			checkpointPaths(worktree, base, 'C1', ['subject.txt', 'other.txt']).code,
		).toBe(0);
		expect(rows(worktree).map((row) => [row[2], row[5]])).toEqual([
			['subject.txt', 'C1'],
			['other.txt', 'C1'],
		]);

		const trace = path.join(worktree, '.agents', 'issue-traces', 'issue-1');
		fs.writeFileSync(
			path.join(trace, '02-reproduction.md'),
			[
				'## Acceptance checks',
				'| AC | class | check | argv | expect | pre-fix | post-fix | notes |',
				'|---|---|---|---|---|---|---|---|',
				'| AC1 | DISCRIMINATING | C1 | bash C1.sh | - | RED | GREEN | two files |',
			].join('\n'),
		);
		const verified = run(REPRO_CHECK, worktree, [
			'verify-semantics',
			'--slug',
			'issue-1',
		]);
		expect(verified.code, `${verified.out}\n${verified.err}`).toBe(0);
		expect(verified.out).toContain('semantics: OK');

		const manifest = manifestFile(worktree);
		const manifestLines = fs
			.readFileSync(manifest, 'utf8')
			.trimEnd()
			.split('\n');
		const divergent = manifestLines[2]?.split('\t');
		if (!divergent) throw new Error('expected second manifest row');
		divergent[6] = 'bash different.sh';
		manifestLines[2] = divergent.join('\t');
		fs.writeFileSync(manifest, `${manifestLines.join('\n')}\n`);
		const rejected = run(REPRO_CHECK, worktree, [
			'verify-semantics',
			'--slug',
			'issue-1',
		]);
		expect(rejected.code).toBe(1);
		expect(rejected.err).toContain('divergent semantics for one check');
	}, 30_000);

	test('allows distinct check ids on one path, captures current bytes, and rejects duplicate pairs', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');

		expect(checkpoint(worktree, base, 'C1').code).toBe(0);
		expect(checkpoint(worktree, base, 'C2').code).toBe(0);
		expect(rows(worktree).map((row) => [row[2], row[5]])).toEqual([
			['subject.txt', 'C1'],
			['subject.txt', 'C2'],
		]);
		expect(
			run(REPRO_CHECK, worktree, ['verify-checkpoint', '--slug', 'issue-1'])
				.code,
		).toBe(0);

		const duplicate = checkpoint(worktree, base, 'C1');
		expect(duplicate.code).toBe(2);
		expect(duplicate.err).toContain('already frozen');
		expect(rows(worktree)).toHaveLength(2);

		// C3 must hash the current file, rather than inheriting C1/C2's old
		// blob.  The resulting divergent effective blobs make verification fail.
		fs.writeFileSync(path.join(worktree, 'subject.txt'), 'changed\n');
		const currentBlob = git(worktree, 'hash-object', 'subject.txt');
		expect(checkpoint(worktree, base, 'C3').code).toBe(0);
		const c3 = rows(worktree).find((row) => row[5] === 'C3');
		expect(c3?.[3]).toBe(currentBlob);
		const divergent = run(REPRO_CHECK, worktree, [
			'verify-checkpoint',
			'--slug',
			'issue-1',
		]);
		expect(divergent.code).toBe(2);
		expect(divergent.err).toContain('conflicting effective blobs');
	}, 30_000);

	test('AMEND supersedes only its exact path/check-id pair and rejects an unknown pair', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		expect(checkpoint(worktree, base, 'C1').code).toBe(0);
		expect(checkpoint(worktree, base, 'C2').code).toBe(0);
		fs.writeFileSync(path.join(worktree, 'subject.txt'), 'changed\n');

		const unknown = checkpoint(worktree, base, 'C3', 'CHECK_WRONG');
		expect(unknown.code).toBe(2);
		expect(unknown.err).toContain(
			'cannot be amended before it is checkpointed',
		);

		expect(checkpoint(worktree, base, 'C1', 'CHECK_WRONG').code).toBe(0);
		// C2 still points at the original bytes, so changing only C1 does not
		// silently supersede the other effective pair.
		const stillDivergent = run(REPRO_CHECK, worktree, [
			'verify-checkpoint',
			'--slug',
			'issue-1',
		]);
		expect(stillDivergent.code).toBe(2);

		expect(checkpoint(worktree, base, 'C2', 'AC_CHANGED_BY_USER').code).toBe(0);
		expect(
			run(REPRO_CHECK, worktree, ['verify-checkpoint', '--slug', 'issue-1'])
				.code,
		).toBe(0);
		const effective = rows(worktree).filter((row) => row[2] === 'subject.txt');
		expect(effective).toHaveLength(4);
		expect(effective.at(-1)?.[5]).toBe('C2');
	}, 30_000);

	test('verification rejects a forged manifest path outside the repository', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		expect(checkpoint(worktree, base, 'C1').code).toBe(0);
		const manifest = fs.readFileSync(manifestFile(worktree), 'utf8');
		fs.writeFileSync(
			manifestFile(worktree),
			manifest.replace('subject.txt', '../../outside.txt'),
		);
		const result = run(REPRO_CHECK, worktree, [
			'verify-checkpoint',
			'--slug',
			'issue-1',
		]);
		expect(result.code).toBe(2);
		expect(result.err).toContain('unsafe path or invalid check id');
	}, 30_000);
});

function writePhase25Trace(worktree: string, manifestRows: string[]): string {
	const trace = path.join(worktree, '.agents/issue-traces/issue-1');
	fs.mkdirSync(path.join(trace, 'repro'), { recursive: true });
	const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
	fs.writeFileSync(
		path.join(trace, 'state.md'),
		[
			'# Trace State: issue-1',
			'protocol: 3.0.0',
			'phase: 2.5',
			'tier: S',
			'classification: VALID',
			'base-ref: main',
			`base-sha: ${git(worktree, 'rev-parse', 'HEAD')}`,
			'freshness: synced',
			`phase0-tree-id: ${tree}`,
			`checkpoint-tree-id: ${tree}`,
			'handshake: MATCH',
			'tools: none',
			'merge: not-applicable',
			'next-action: test',
			'',
		].join('\n'),
	);
	fs.writeFileSync(
		path.join(trace, '01-issue-summary.md'),
		'## Source\nx\n## Observed Behavior\nx\n## Expected Behavior\nx\n## Acceptance Criteria\n- [ ] AC1: first\n- [ ] AC2: second\n## Classification\nVALID\n## Related Issues\nx\n',
	);
	fs.writeFileSync(
		path.join(trace, '02-reproduction.md'),
		[
			'## Commands Tried',
			'```text',
			'run',
			'```',
			'- Exit code: 1',
			'## Reproduction Verdict',
			'red',
			'## Acceptance checks',
			'| AC | class | check | argv | expect | pre-fix | post-fix | notes |',
			'|---|---|---|---|---|---|---|---|',
			'| AC1 | DISCRIMINATING | C1 | cmd | fail | RED | GREEN | first |',
			'| AC2 | DISCRIMINATING | C2 | cmd | fail | RED | GREEN | second |',
			'## Red checkpoint',
			'checkpoint-tree-id: ' + treePlaceholder,
		].join('\n'),
	);
	const reproduction = path.join(trace, '02-reproduction.md');
	fs.writeFileSync(
		reproduction,
		fs.readFileSync(reproduction, 'utf8').replace(treePlaceholder, tree),
	);
	for (const id of ['C1', 'C2'])
		fs.writeFileSync(path.join(trace, 'repro', `${id}.base.log`), 'fail\n');
	fs.writeFileSync(
		path.join(trace, 'repro/checkpoint.manifest'),
		`# issue-tracer checkpoint manifest v1 rows=${manifestRows.length}\n${manifestRows.join('\n')}\n`,
	);
	return trace;
}

const treePlaceholder = '__TREE__';

describe('trace-check.sh Phase 2.5 same-path tree derivation (F2566-MP)', () => {
	test('Phase 2.5 rejects semantic drift through the read-only verifier (F2813-3)', () => {
		const worktree = repo('trace-phase25-semantics-2566-');
		const blob = 'a'.repeat(40);
		const base = 'b'.repeat(40);
		const row = (seq: number, id: string) =>
			`${seq}\tCHECKPOINT\tsubject.txt\t${blob}\t100644\t${id}\tcmd\tfail\t${base}\t-`;
		const trace = writePhase25Trace(worktree, [row(1, 'C1'), row(2, 'C2')]);
		const reproduction = path.join(trace, '02-reproduction.md');
		fs.writeFileSync(
			reproduction,
			fs
				.readFileSync(reproduction, 'utf8')
				.replace(
					'| AC2 | DISCRIMINATING | C2 | cmd |',
					'| AC2 | DISCRIMINATING | C2 | drift |',
				),
		);

		const result = run(TRACE_CHECK, worktree, [
			'phase',
			'2.5',
			'--slug',
			'issue-1',
		]);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL acceptance-manifest-semantics');
	}, 30_000);

	test('deduplicates identical effective blobs but rejects conflicting ones', () => {
		const worktree = repo('trace-multi-pair-2566-');
		const blob = 'a'.repeat(40);
		const base = 'b'.repeat(40);
		const row = (seq: number, id: string, value: string) =>
			`${seq}\tCHECKPOINT\tsubject.txt\t${value}\t100644\t${id}\tcmd\tfail\t${base}\t-`;
		const trace = writePhase25Trace(worktree, [
			row(1, 'C1', blob),
			row(2, 'C2', blob),
		]);
		let result = run(TRACE_CHECK, worktree, [
			'phase',
			'2.5',
			'--slug',
			'issue-1',
		]);
		expect(result.code).toBe(0);
		expect(result.out).toContain('OK manifest-effective-blobs');

		fs.writeFileSync(
			path.join(trace, 'repro/checkpoint.manifest'),
			`# issue-tracer checkpoint manifest v1 rows=2\n${row(1, 'C1', blob)}\n${row(2, 'C2', 'b'.repeat(40))}\n`,
		);
		result = run(TRACE_CHECK, worktree, ['phase', '2.5', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL manifest-effective-blobs');
	});
});
