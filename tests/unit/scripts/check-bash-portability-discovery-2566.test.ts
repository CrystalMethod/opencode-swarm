import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	discoverShellFiles,
	evaluateBashPortability,
	main,
	type ShellDiscoveryDeps,
} from '../../../scripts/check-bash-portability';
import { bashCommand } from '../../helpers/bash';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

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

afterEach(() => {
	for (const root of roots.splice(0)) safeRmRecursive(root);
});

function makeRepo(): string {
	const repo = canonicalMkdtemp('bash-portability-discovery-errors-');
	roots.push(repo);
	git(repo, 'init', '-q', '-b', 'main');
	fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
	fs.writeFileSync(
		path.join(repo, 'scripts', 'check.sh'),
		'#!/usr/bin/env bash\n',
	);
	return repo;
}

function pathEvidence(value: string): string {
	return value.replace(/\\/g, '/').split('/').slice(-2).join('/');
}

function runScript(cwd: string, args: string[], env?: Record<string, string>) {
	const proc = Bun.spawnSync({
		cmd: bashCommand(
			path.resolve(
				process.cwd(),
				'.opencode/skills/issue-tracer/scripts/repro-check.sh',
			),
			...args,
		),
		cwd,
		env: { ...process.env, ...env },
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

async function runWithDeps(
	repo: string,
	deps: ShellDiscoveryDeps,
): Promise<string> {
	const output: string[] = [];
	const originalLog = console.log;
	console.log = (...args: unknown[]) => output.push(args.join(' '));
	try {
		expect(await main(repo, deps)).toBe(1);
	} finally {
		console.log = originalLog;
	}
	return output.join('\n');
}

describe('check-bash-portability discovery failures (#2566)', () => {
	test('summary names every scanned shell root', () => {
		const report = evaluateBashPortability([
			{ file: 'scripts/ok.sh', content: '#!/usr/bin/env bash\n' },
		]).messages.join('\n');

		expect(report).toContain('scripts/');
		expect(report).toContain('.opencode/skills/');
		expect(report).toContain('.claude/skills/');
		expect(report).toContain('.agents/skills/');
	});

	test('does not follow a symlinked native skill directory', () => {
		const repo = canonicalMkdtemp('bash-portability-discovery-link-');
		const outside = canonicalMkdtemp('bash-portability-discovery-outside-');
		roots.push(repo, outside);
		const linkedSkill = path.join(outside, 'linked-skill');
		fs.mkdirSync(linkedSkill, { recursive: true });
		fs.writeFileSync(
			path.join(linkedSkill, 'forbidden.sh'),
			'declare -A bad=()\n',
		);
		const nativeRoot = path.join(repo, '.agents', 'skills');
		fs.mkdirSync(nativeRoot, { recursive: true });
		fs.symlinkSync(
			linkedSkill,
			path.join(nativeRoot, 'linked-skill'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		const result = discoverShellFiles(repo);

		expect(result.errors).toHaveLength(0);
		expect(result.files.some((file) => file.includes('forbidden.sh'))).toBe(
			false,
		);
	});

	test.skipIf(process.platform !== 'win32')(
		'creates a junction from a repository path containing spaces and fails closed when cmd is unavailable',
		() => {
			const parent = canonicalMkdtemp('bash-portability-link-parent-');
			const repo = path.join(parent, 'repo path with spaces');
			roots.push(parent);
			fs.mkdirSync(repo);
			git(repo, 'init', '-q', '-b', 'main');
			git(repo, 'config', 'user.email', 'trace@example.invalid');
			git(repo, 'config', 'user.name', 'Trace');
			fs.writeFileSync(
				path.join(repo, 'check.sh'),
				'#!/usr/bin/env bash\ntest -f node_modules/marker.txt\n',
			);
			git(repo, 'add', 'check.sh');
			git(repo, 'commit', '-q', '-m', 'seed');
			const base = git(repo, 'rev-parse', 'HEAD');
			fs.mkdirSync(path.join(repo, 'node_modules'));
			fs.writeFileSync(
				path.join(repo, 'node_modules', 'marker.txt'),
				'present\n',
			);

			const linked = runScript(repo, [
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
				'link',
				'--timeout',
				'5',
				'--',
				'bash',
				'-c',
				'test -f node_modules/marker.txt',
			]);
			expect(linked.code, `${linked.out}\n${linked.err}`).toBe(0);

			const copied = runScript(repo, [
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
				'link',
				'--copy',
				'node_modules',
				'--timeout',
				'5',
				'--',
				'bash',
				'-c',
				'test -f node_modules/marker.txt',
			]);
			expect(copied.code).not.toBe(0);
			expect(copied.err).toContain('existing dependency target');

			const shimDir = path.join(parent, 'unavailable cmd');
			fs.mkdirSync(shimDir);
			fs.writeFileSync(
				path.join(shimDir, 'cmd'),
				'#!/usr/bin/env bash\nexit 127\n',
			);
			fs.chmodSync(path.join(shimDir, 'cmd'), 0o755);
			const unavailable = runScript(
				repo,
				[
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
					'link',
					'--timeout',
					'5',
					'--',
					'bash',
					'-c',
					'test -f node_modules/marker.txt',
				],
				{ PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}` },
			);
			expect(unavailable.code).not.toBe(0);
			expect(unavailable.err).toContain('could not create dependency junction');
		},
		30_000,
	);

	test('enumeration failure is nonzero and reports an incomplete scan', async () => {
		const report = await runWithDeps(makeRepo(), {
			readdirSync: () => {
				throw new Error('synthetic enumeration failure');
			},
		});

		expect(report).toContain('shell discovery could not enumerate scripts');
		expect(report).toContain('portability scan is incomplete');
	});

	test('resolves unknown directory entry types with lstat instead of skipping them', () => {
		const repo = makeRepo();
		const scripts = path.join(repo, 'scripts');
		const unknownShell = path.join(scripts, 'unknown.sh');
		fs.writeFileSync(unknownShell, '#!/usr/bin/env bash\n');
		const unknownEntry = {
			name: 'unknown.sh',
			isDirectory: () => false,
			isFile: () => false,
			isSymbolicLink: () => false,
			isBlockDevice: () => false,
			isCharacterDevice: () => false,
			isFIFO: () => false,
			isSocket: () => false,
		} as fs.Dirent;
		const lstatCalls: string[] = [];
		const result = discoverShellFiles(repo, 20_000, {
			readdirSync: (directory) =>
				directory === scripts
					? [unknownEntry]
					: fs.readdirSync(directory, { withFileTypes: true }),
			lstatSync: (file) => {
				lstatCalls.push(file);
				return fs.lstatSync(file);
			},
		});

		expect(result.errors).toHaveLength(0);
		// Windows native realpath may spell the temp root with a different
		// 8.3/long-name alias than the fixture path. Preserve the meaningful
		// evidence — the scanner found this exact repository-relative file.
		expect(result.files.map(pathEvidence)).toContain(
			pathEvidence(unknownShell),
		);
		expect(lstatCalls).toContain(unknownShell);
	});

	test('fails closed when an unknown directory entry cannot be inspected', async () => {
		const repo = makeRepo();
		const scripts = path.join(repo, 'scripts');
		const unknownShell = path.join(scripts, 'unknown.sh');
		fs.writeFileSync(unknownShell, '#!/usr/bin/env bash\n');
		const unknownEntry = {
			name: 'unknown.sh',
			isDirectory: () => false,
			isFile: () => false,
			isSymbolicLink: () => false,
			isBlockDevice: () => false,
			isCharacterDevice: () => false,
			isFIFO: () => false,
			isSocket: () => false,
		} as fs.Dirent;
		const report = await runWithDeps(repo, {
			readdirSync: (directory) =>
				directory === scripts
					? [unknownEntry]
					: fs.readdirSync(directory, { withFileTypes: true }),
			lstatSync: (file) => {
				if (file === unknownShell) throw new Error('synthetic lstat failure');
				return fs.lstatSync(file);
			},
		});

		expect(report).toContain(
			'shell discovery could not inspect scripts/unknown.sh after unknown directory entry type',
		);
		expect(report).toContain('portability scan is incomplete');
	});

	test('canonicalization failure is nonzero and reports an incomplete scan', async () => {
		const report = await runWithDeps(makeRepo(), {
			realpathSync: () => {
				throw new Error('synthetic canonicalization failure');
			},
		});

		expect(report).toContain(
			'shell discovery could not canonicalize scripts/check.sh',
		);
		expect(report).toContain('portability scan is incomplete');
	});

	test('inaccessible scan roots are nonzero instead of being treated as absent', async () => {
		const repo = makeRepo();
		const scripts = path.join(repo, 'scripts');
		const report = await runWithDeps(repo, {
			lstatSync: (candidate) => {
				if (candidate === scripts) {
					throw Object.assign(new Error('synthetic access denial'), {
						code: 'EACCES',
					});
				}
				return fs.lstatSync(candidate);
			},
		});

		expect(report).toContain('shell discovery could not inspect scripts');
		expect(report).toContain('portability scan is incomplete');
	});

	test('skips and reports a symlinked scan root without following it', () => {
		const repo = canonicalMkdtemp('bash-portability-discovery-root-link-');
		const outside = canonicalMkdtemp(
			'bash-portability-discovery-root-outside-',
		);
		roots.push(repo, outside);
		const linkedSkills = path.join(outside, 'skills');
		fs.mkdirSync(linkedSkills, { recursive: true });
		fs.writeFileSync(
			path.join(linkedSkills, 'forbidden.sh'),
			'declare -A bad=()\n',
		);
		const agents = path.join(repo, '.agents');
		fs.mkdirSync(agents, { recursive: true });
		fs.symlinkSync(
			linkedSkills,
			path.join(agents, 'skills'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		const result = discoverShellFiles(repo);

		expect(result.errors).toContain(
			'skipping symlinked scan root .agents/skills',
		);
		expect(result.files.some((file) => file.includes('forbidden.sh'))).toBe(
			false,
		);
	});
});
