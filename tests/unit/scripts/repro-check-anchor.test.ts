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

function makeRepo(): {
	repo: string;
	base: string;
	trace: string;
	manifest: string;
} {
	const repo = canonicalMkdtemp('repro-check-anchor-');
	roots.push(repo);
	git(repo, 'init', '-q', '-b', 'main');
	git(repo, 'config', 'user.email', 'trace@example.invalid');
	git(repo, 'config', 'user.name', 'Trace');
	fs.writeFileSync(
		path.join(repo, 'check.sh'),
		'#!/usr/bin/env bash\nexit 1\n',
	);
	fs.chmodSync(path.join(repo, 'check.sh'), 0o755);
	git(repo, 'add', 'check.sh');
	git(repo, 'commit', '-q', '-m', 'seed');
	const base = git(repo, 'rev-parse', 'HEAD');
	const trace = path.join(repo, '.agents', 'issue-traces', 'issue-2566');
	const manifest = path.join(trace, 'repro', 'checkpoint.manifest');
	const checkpoint = run(repo, [
		'checkpoint',
		'--slug',
		'issue-2566',
		'--id',
		'C1',
		'--argv',
		'bash check.sh',
		'--expect',
		'-',
		'--base',
		base,
		'check.sh',
	]);
	if (checkpoint.code !== 0)
		throw new Error(`${checkpoint.out}\n${checkpoint.err}`);
	const tree = git(repo, 'rev-parse', 'HEAD^{tree}');
	fs.writeFileSync(
		path.join(trace, 'state.md'),
		[
			'# Trace State: issue-2566',
			'protocol: 3.0.0',
			`checkpoint-tree-id: ${tree}`,
			'',
		].join('\n'),
	);
	fs.writeFileSync(
		path.join(trace, '02-reproduction.md'),
		[
			'## Acceptance checks',
			'| AC | class | check | argv | expect | pre-fix | post-fix | notes |',
			'|---|---|---|---|---|---|---|---|',
			'| AC1 | DISCRIMINATING | C1 | bash check.sh | - | RED | GREEN | anchor |',
		].join('\n'),
	);
	return { repo, base, trace, manifest };
}

function anchor(repo: string): string {
	const result = run(repo, ['anchor', '--slug', 'issue-2566']);
	if (result.code !== 0) throw new Error(`${result.out}\n${result.err}`);
	const lines = result.out.trim().split(/\r?\n/);
	expect(lines).toHaveLength(1);
	const receipt = lines[0] ?? '';
	expect(receipt).toMatch(
		/^issue-tracer-checkpoint-v1 slug=issue-2566 manifest=[0-9a-f]{40} semantics=[0-9a-f]{40} tree=[0-9a-f]{40}$/,
	);
	return receipt;
}

describe('repro-check.sh external checkpoint anchors (#2566)', () => {
	test('verifies the receipt repeatedly and rejects malformed or stale evidence', () => {
		const { repo, manifest } = makeRepo();
		const receipt = anchor(repo);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const verified = run(repo, [
				'verify-anchor',
				'--slug',
				'issue-2566',
				'--receipt',
				receipt,
			]);
			expect(verified.code, `${verified.out}\n${verified.err}`).toBe(0);
		}

		const malformed = run(repo, [
			'verify-anchor',
			'--slug',
			'issue-2566',
			'--receipt',
			`${receipt} extra`,
		]);
		expect(malformed.code).toBe(2);

		const lines = fs.readFileSync(manifest, 'utf8').split('\n');
		lines[1] = lines[1].replace(/\t[0-9a-f]{40}\t/, `\t${'f'.repeat(40)}\t`);
		fs.writeFileSync(manifest, lines.join('\n'));
		const tampered = run(repo, [
			'verify-anchor',
			'--slug',
			'issue-2566',
			'--receipt',
			receipt,
		]);
		expect(tampered.code).toBe(1);
	});

	test('binds acceptance-table semantics to the external receipt', () => {
		const { repo, trace } = makeRepo();
		const receipt = anchor(repo);
		const reproduction = path.join(trace, '02-reproduction.md');
		const original = fs.readFileSync(reproduction, 'utf8');
		// Before the semantic digest, changing only the table's AC cell left the
		// unchanged manifest and external receipt apparently valid.
		fs.writeFileSync(
			reproduction,
			original.replace('| AC1 | DISCRIMINATING |', '| AC2 | DISCRIMINATING |'),
		);
		const tampered = run(repo, [
			'verify-anchor',
			'--slug',
			'issue-2566',
			'--receipt',
			receipt,
		]);
		expect(tampered.code).toBe(1);
		expect(tampered.err).toContain('anchor semantic digest');
	});

	test('rejects pre-semantics anchor receipts without a migration', () => {
		const { repo } = makeRepo();
		const receipt = anchor(repo);
		const legacyReceipt = receipt.replace(/ semantics=[0-9a-f]{40}/, '');
		const result = run(repo, [
			'verify-anchor',
			'--slug',
			'issue-2566',
			'--receipt',
			legacyReceipt,
		]);
		expect(result.code).toBe(2);
		expect(result.err).toContain('malformed anchor receipt');
	});

	test('uses no-filter bytes and recorded checkpoint state across CRLF and refreeze cases', () => {
		const { repo, base, trace, manifest } = makeRepo();
		const receipt = anchor(repo);

		const crlf = fs.readFileSync(manifest, 'utf8').replace(/\n/g, '\r\n');
		fs.writeFileSync(manifest, crlf);
		const crlfResult = run(repo, [
			'verify-anchor',
			'--slug',
			'issue-2566',
			'--receipt',
			receipt,
		]);
		expect(crlfResult.code).toBe(2);
		expect(crlfResult.err).toContain('invalid manifest header');

		fs.unlinkSync(manifest);
		const refrozen = run(repo, [
			'checkpoint',
			'--slug',
			'issue-2566',
			'--id',
			'C1',
			'--argv',
			'bash check.sh',
			'--expect',
			'-',
			'--base',
			base,
			'check.sh',
		]);
		expect(refrozen.code, `${refrozen.out}\n${refrozen.err}`).toBe(0);
		const identical = run(repo, [
			'verify-anchor',
			'--slug',
			'issue-2566',
			'--receipt',
			receipt,
		]);
		expect(identical.code).toBe(0);

		// A delete-and-refreeze with weakened content must not be able to reuse
		// the old external receipt. The new manifest is internally valid, but its
		// no-filter digest is different from the anchored one.
		fs.writeFileSync(
			path.join(repo, 'check.sh'),
			'#!/usr/bin/env bash\nexit 0\n',
		);
		fs.unlinkSync(manifest);
		const weakenedRefreeze = run(repo, [
			'checkpoint',
			'--slug',
			'issue-2566',
			'--id',
			'C1',
			'--argv',
			'bash check.sh',
			'--expect',
			'-',
			'--base',
			base,
			'check.sh',
		]);
		expect(
			weakenedRefreeze.code,
			`${weakenedRefreeze.out}\n${weakenedRefreeze.err}`,
		).toBe(0);
		const weakened = run(repo, [
			'verify-anchor',
			'--slug',
			'issue-2566',
			'--receipt',
			receipt,
		]);
		expect(weakened.code).toBe(1);

		const state = path.join(trace, 'state.md');
		const stateText = fs.readFileSync(state, 'utf8');
		fs.writeFileSync(
			state,
			stateText.replace(
				/checkpoint-tree-id: [0-9a-f]{40}/,
				`checkpoint-tree-id: ${'e'.repeat(40)}`,
			),
		);
		const drifted = run(repo, [
			'verify-anchor',
			'--slug',
			'issue-2566',
			'--receipt',
			receipt,
		]);
		expect(drifted.code).toBe(1);
	});
});
