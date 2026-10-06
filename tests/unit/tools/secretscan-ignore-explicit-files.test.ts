/**
 * Issue #3107 — `.secretscanignore` on the explicit-files secretscan path.
 *
 * `runSecretscanOnFiles` (the pre_check_batch changed-file Stage-A engine)
 * must load and apply `.secretscanignore` with the same pattern language and
 * precedence as the directory scan (#152): exact names + globs, comments and
 * unsafe patterns skipped, ancestor directories prune like traversal. The
 * #2918 fail-closed accounting is preserved: ignore suppressions count toward
 * `skipped_files` only — never `policy_skipped_files` — so an all-ignored
 * batch keeps failing the zero-coverage arm.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runPreCheckBatch } from '../../../src/tools/pre-check-batch';
import {
	runSecretscanOnFiles,
	type SecretscanErrorResult,
	type SecretscanResult,
	secretscan,
} from '../../../src/tools/secretscan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;
let outsideDir: string | undefined;

function successful(
	result: SecretscanResult | SecretscanErrorResult,
): SecretscanResult {
	if ('error' in result) throw new Error(result.error);
	return result;
}

function write(dir: string, file: string, content: string): void {
	const full = path.join(dir, file);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content);
}

function writeIgnore(dir: string, content: string): void {
	fs.writeFileSync(path.join(dir, '.secretscanignore'), content, 'utf-8');
}

function findingsFor(result: SecretscanResult, needle: string): number {
	return result.findings.filter((f) => f.path.includes(needle)).length;
}

async function gitProject(dir: string): Promise<string> {
	const run = (cmd: string[]) => {
		const proc = Bun.spawnSync(cmd, {
			cwd: dir,
			stdin: 'ignore',
			stdout: 'ignore',
			stderr: 'ignore',
		});
		if (proc.exitCode !== 0) throw new Error(`git failed: ${cmd.join(' ')}`);
	};
	run(['git', 'init']);
	run(['git', 'config', 'user.email', 'test@test.com']);
	run(['git', 'config', 'user.name', 'Test']);
	run(['git', 'config', 'commit.gpgsign', 'false']);
	return dir;
}

function scanSlot(result: Awaited<ReturnType<typeof runPreCheckBatch>>): {
	files_scanned: number;
	skipped_files: number;
	policy_skipped_files: number;
	requested_files: number;
	incomplete_files: number;
	findings: Array<{ path: string }>;
	count: number;
} {
	const res = result.secretscan.result as
		| {
				files_scanned: number;
				skipped_files: number;
				policy_skipped_files: number;
				requested_files: number;
				incomplete_files: number;
				findings: Array<{ path: string }>;
				count: number;
		  }
		| undefined;
	if (!res) throw new Error('no secretscan result slot');
	return res;
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('secretscan-ignore-3107-');
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
	if (outsideDir) {
		fs.rmSync(outsideDir, { recursive: true, force: true });
		outsideDir = undefined;
	}
});

describe('#3107 .secretscanignore on runSecretscanOnFiles', () => {
	test('directory/explicit parity: a pattern that suppresses on one path suppresses on the other', async () => {
		writeIgnore(tempDir, '# ignore generated\n**/generated/**\n');
		write(tempDir, path.join('generated', 'token.txt'), 'password=genSecret\n');
		write(tempDir, path.join('src', 'config.txt'), 'password=appSecret\n');

		const explicit = successful(
			await runSecretscanOnFiles(
				[
					path.join(tempDir, 'generated', 'token.txt'),
					path.join(tempDir, 'src', 'config.txt'),
				],
				tempDir,
			),
		);
		const directory = JSON.parse(
			String(
				await secretscan.execute(
					{ directory: tempDir },
					{} as unknown as never,
				),
			),
		) as { findings: Array<{ path: string }> };

		// Both engines suppress the ignore-matched file...
		expect(findingsFor(explicit, 'generated')).toBe(0);
		expect(
			directory.findings.filter((f) => f.path.includes('generated')),
		).toHaveLength(0);
		// ...and both still report the non-ignored finding (non-vacuous).
		expect(findingsFor(explicit, 'config.txt')).toBe(1);
		expect(
			directory.findings.filter((f) => f.path.includes('config.txt')),
		).toHaveLength(1);
		expect(explicit.files_scanned).toBe(1);
		expect(explicit.skipped_files).toBe(1);
	});

	test('exact directory-name pattern prunes nested files like traversal', async () => {
		writeIgnore(tempDir, 'generated\n');
		write(
			tempDir,
			path.join('nested', 'generated', 'token.txt'),
			'password=genSecret\n',
		);

		const result = successful(
			await runSecretscanOnFiles(
				[path.join(tempDir, 'nested', 'generated', 'token.txt')],
				tempDir,
			),
		);
		expect(result.findings).toHaveLength(0);
		expect(result.files_scanned).toBe(0);
		expect(result.skipped_files).toBe(1);
		expect(result.incomplete_files).toBe(0);
	});

	test('cross-engine parity for exact-name ancestor pruning (drift guard)', async () => {
		// Issue #3107 ask (b): both engines must honor the SAME pattern
		// language — this pins the plain-name/ancestor-pruning shape
		// cross-engine, complementing the glob-shape parity test above.
		writeIgnore(tempDir, 'generated\n');
		write(
			tempDir,
			path.join('nested', 'generated', 'token.txt'),
			'password=genSecret\n',
		);
		write(tempDir, path.join('src', 'config.txt'), 'password=appSecret\n');

		const explicit = successful(
			await runSecretscanOnFiles(
				[
					path.join(tempDir, 'nested', 'generated', 'token.txt'),
					path.join(tempDir, 'src', 'config.txt'),
				],
				tempDir,
			),
		);
		const directory = JSON.parse(
			String(
				await secretscan.execute(
					{ directory: tempDir },
					{} as unknown as never,
				),
			),
		) as { findings: Array<{ path: string }> };

		expect(findingsFor(explicit, 'generated')).toBe(0);
		expect(
			directory.findings.filter((f) => f.path.includes('generated')),
		).toHaveLength(0);
		expect(findingsFor(explicit, 'config.txt')).toBe(1);
		expect(
			directory.findings.filter((f) => f.path.includes('config.txt')),
		).toHaveLength(1);
		expect(explicit.files_scanned).toBe(1);
		expect(explicit.skipped_files).toBe(1);
	});

	test('explicitly requested files under default-excluded directories stay scannable (non-seeding pin)', async () => {
		// Pins the deliberate NOT-seeding of DEFAULT_EXCLUDE_DIRS on the
		// explicit path: changed-file coverage must not silently darken for
		// files the caller explicitly requested.
		write(
			tempDir,
			path.join('node_modules', 'pkg', 'secret.txt'),
			'password=nestedSecret\n',
		);

		const result = successful(
			await runSecretscanOnFiles(
				[path.join(tempDir, 'node_modules', 'pkg', 'secret.txt')],
				tempDir,
			),
		);
		expect(result.files_scanned).toBe(1);
		expect(result.findings).toHaveLength(1);
		expect(result.skipped_files).toBe(0);
	});

	test('comment lines are skipped, not treated as patterns', async () => {
		// The raw comment line doubles as an exact-name pattern for the
		// '#abc.txt' fixture file: if the loader ever stopped skipping
		// comments, that raw line would suppress '#abc.txt' and this test
		// would go red (PRR-007).
		writeIgnore(tempDir, '#abc.txt\n');
		write(tempDir, '#abc.txt', 'password=hashSecret\n');
		write(tempDir, 'config.txt', 'password=appSecret\n');

		const result = successful(
			await runSecretscanOnFiles(
				[path.join(tempDir, '#abc.txt'), path.join(tempDir, 'config.txt')],
				tempDir,
			),
		);
		expect(findingsFor(result, '#abc.txt')).toBe(1);
		expect(findingsFor(result, 'config.txt')).toBe(1);
		expect(result.files_scanned).toBe(2);
		expect(result.skipped_files).toBe(0);
	});

	test('CRLF line endings in .secretscanignore are honored', async () => {
		writeIgnore(tempDir, '**/generated/**\r\n');
		write(tempDir, path.join('generated', 'token.txt'), 'password=genSecret\n');
		write(tempDir, 'app.txt', 'nothing here\n');

		const result = successful(
			await runSecretscanOnFiles(
				[
					path.join(tempDir, 'generated', 'token.txt'),
					path.join(tempDir, 'app.txt'),
				],
				tempDir,
			),
		);
		expect(findingsFor(result, 'generated')).toBe(0);
		expect(result.files_scanned).toBe(1);
		expect(result.skipped_files).toBe(1);
	});

	test('ignore suppression counts skipped_files only — never a policy or incomplete skip', async () => {
		writeIgnore(tempDir, '**/generated/**\n');
		write(tempDir, path.join('generated', 'token.txt'), 'password=genSecret\n');
		write(tempDir, 'app.txt', 'nothing here\n');

		const result = successful(
			await runSecretscanOnFiles(
				[
					path.join(tempDir, 'generated', 'token.txt'),
					path.join(tempDir, 'app.txt'),
				],
				tempDir,
			),
		);
		expect(result.files_scanned).toBe(1);
		expect(result.skipped_files).toBe(1);
		// #2918 fail-closed doctrine: a repo-writable ignore file must never
		// satisfy the vacuous-coverage predicate.
		expect(result.policy_skipped_files).toBe(0);
		expect(result.requested_files).toBe(2);
		expect(result.incomplete_files).toBe(0);
		expect(result.incomplete_paths).toEqual([]);
	});

	test('unsafe patterns are silently skipped while sibling safe patterns apply', async () => {
		writeIgnore(tempDir, '../etc/passwd\n*.conf\n');
		write(tempDir, 'app.conf', 'password=confSecret\n');

		const result = successful(
			await runSecretscanOnFiles([path.join(tempDir, 'app.conf')], tempDir),
		);
		expect(result.findings).toHaveLength(0);
		expect(result.skipped_files).toBe(1);
	});

	test('comments/blank-only ignore file does not suppress', async () => {
		writeIgnore(tempDir, '# this is a comment\n\n   \n');
		write(tempDir, 'config.txt', 'password=appSecret\n');

		const result = successful(
			await runSecretscanOnFiles([path.join(tempDir, 'config.txt')], tempDir),
		);
		expect(findingsFor(result, 'config.txt')).toBe(1);
		expect(result.files_scanned).toBe(1);
	});

	test('ignore-matched missing file stays incomplete (fail-closed)', async () => {
		writeIgnore(tempDir, 'missing.txt\n');

		const result = successful(
			await runSecretscanOnFiles([path.join(tempDir, 'missing.txt')], tempDir),
		);
		expect(result.files_scanned).toBe(0);
		expect(result.incomplete_files).toBe(1);
		expect(result.incomplete_paths[0]?.reason).toBe('missing');
	});

	test.skipIf(process.platform === 'win32')(
		'ignore-matched symlink stays incomplete (fail-closed)',
		async () => {
			write(tempDir, 'target.txt', 'clean\n');
			fs.symlinkSync(
				path.join(tempDir, 'target.txt'),
				path.join(tempDir, 'link.txt'),
				'file',
			);
			writeIgnore(tempDir, 'link.txt\n');

			const result = successful(
				await runSecretscanOnFiles([path.join(tempDir, 'link.txt')], tempDir),
			);
			expect(result.files_scanned).toBe(0);
			expect(result.incomplete_files).toBe(1);
			expect(result.incomplete_paths[0]?.reason).toBe('symlink');
		},
	);

	test('ignore-matched scope escape stays incomplete (never a benign skip)', async () => {
		outsideDir = canonicalMkdtemp('secretscan-3107-outside-');
		write(outsideDir, 'outside.txt', 'password=outsideSecret\n');
		fs.symlinkSync(
			outsideDir,
			path.join(tempDir, 'escape'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		writeIgnore(tempDir, 'escape/**\n');

		const result = successful(
			await runSecretscanOnFiles(
				[path.join(tempDir, 'escape', 'outside.txt')],
				tempDir,
			),
		);
		expect(result.findings).toHaveLength(0);
		expect(result.files_scanned).toBe(0);
		expect(result.skipped_files).toBe(1);
		expect(result.incomplete_files).toBe(1);
		expect(result.incomplete_paths[0]?.reason).toBe('scope_escape');
	});

	test('docs-ext ∩ ignore overlap keeps the #2918 extension accounting (ext-first pin)', async () => {
		// Deliberate ext-first ordering (#3107 plan F-1): the extension route
		// is evaluated before the ignore check, so a docs-safe ignore-matched
		// file keeps the same accounting and outcome it has at base, where the
		// ignore file is inert for extension-excluded files.
		writeIgnore(tempDir, 'docs/**\n');
		write(tempDir, path.join('docs', 'notes.md'), 'password=docSecret\n');

		const result = successful(
			await runSecretscanOnFiles(
				[path.join(tempDir, 'docs', 'notes.md')],
				tempDir,
			),
		);
		expect(result.files_scanned).toBe(0);
		expect(result.policy_skipped_files).toBe(1);
		expect(result.skipped_files).toBe(1);
		expect(result.requested_files).toBe(1);
		expect(result.incomplete_files).toBe(0);
	});
});

describe('#3107 pre_check_batch changed-file gate', () => {
	test('mixed batch passes when the only secret is ignore-matched and a clean file is scanned', async () => {
		const dir = await gitProject(tempDir);
		writeIgnore(dir, '**/generated/**\n');
		write(dir, path.join('generated', 'token.txt'), 'password=genSecret\n');
		write(dir, path.join('src', 'clean.txt'), 'nothing to see here\n');

		const result = await runPreCheckBatch(
			{ files: ['generated/token.txt', 'src/clean.txt'], directory: dir },
			dir,
			dir,
		);
		expect(result.gates_passed).toBe(true);
		const scan = scanSlot(result);
		expect(scan.files_scanned).toBe(1);
		expect(scan.skipped_files).toBe(1);
		expect(scan.policy_skipped_files).toBe(0);
		expect(scan.requested_files).toBe(2);
		expect(scan.incomplete_files).toBe(0);
		expect(scan.findings).toHaveLength(0);
	});

	test('all-ignored batch stays fail-closed (zero-coverage arm, never vacuous)', async () => {
		const dir = await gitProject(tempDir);
		writeIgnore(dir, '**/*\n');
		write(dir, path.join('a', 'generated', 'x.txt'), 'password=secretOne\n');
		write(dir, path.join('b', 'generated', 'y.txt'), 'password=secretTwo\n');

		const result = await runPreCheckBatch(
			{
				files: ['a/generated/x.txt', 'b/generated/y.txt'],
				directory: dir,
			},
			dir,
			dir,
		);
		expect(result.gates_passed).toBe(false);
		const scan = scanSlot(result);
		expect(scan.files_scanned).toBe(0);
		expect(scan.skipped_files).toBe(2);
		// The ignore file cannot satisfy the vacuous-coverage predicate
		// (policy 0 < requested 2), so the only failing arm left is the
		// zero-coverage "zero requested files scanned" arm.
		expect(scan.policy_skipped_files).toBe(0);
		expect(scan.requested_files).toBe(2);
		expect(scan.incomplete_files).toBe(0);
	});
});
