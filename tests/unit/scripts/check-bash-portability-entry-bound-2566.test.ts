import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	discoverShellFiles,
	main,
} from '../../../scripts/check-bash-portability';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): void {
	const proc = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	});
	if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
}

afterEach(() => {
	for (const root of roots.splice(0)) safeRmRecursive(root);
});

describe('check-bash-portability streaming discovery bound (#2566)', () => {
	test('stops reading a directory after the first entry beyond the bound', () => {
		const repo = canonicalMkdtemp('bash-portability-entry-bound-');
		roots.push(repo);
		const scripts = path.join(repo, 'scripts');
		fs.mkdirSync(scripts);
		for (const name of ['a.sh', 'b.sh', 'c.sh']) {
			fs.writeFileSync(path.join(scripts, name), '#!/usr/bin/env bash\n');
		}

		const entries = fs.readdirSync(scripts, { withFileTypes: true });
		let reads = 0;
		let closed = 0;
		let next = 0;
		const result = discoverShellFiles(repo, 2, {
			opendirSync: () => ({
				readSync: () => {
					reads += 1;
					return entries[next++] ?? null;
				},
				closeSync: () => {
					closed += 1;
				},
			}),
		});

		expect(reads).toBe(3);
		expect(closed).toBe(1);
		expect(result.files).toHaveLength(2);
		expect(result.errors).toContain('entry limit 2 exceeded under scripts');
	});

	test('rejects nested entries whose canonical target escapes the repository', () => {
		const repo = canonicalMkdtemp('bash-portability-canonical-root-');
		const outside = canonicalMkdtemp('bash-portability-canonical-outside-');
		roots.push(repo, outside);
		const scripts = path.join(repo, 'scripts');
		const nested = path.join(scripts, 'nested');
		const escaped = path.join(outside, 'escaped');
		fs.mkdirSync(scripts);
		fs.mkdirSync(escaped);
		const entry = {
			name: 'nested',
			isDirectory: () => true,
			isFile: () => false,
			isSymbolicLink: () => false,
			isBlockDevice: () => false,
			isCharacterDevice: () => false,
			isFIFO: () => false,
			isSocket: () => false,
		} as fs.Dirent;
		const result = discoverShellFiles(repo, 20_000, {
			opendirSync: (directory) => {
				if (directory !== scripts) {
					return { readSync: () => null, closeSync: () => {} };
				}
				let consumed = false;
				return {
					readSync: () => {
						if (consumed) return null;
						consumed = true;
						return entry;
					},
					closeSync: () => {},
				};
			},
			realpathSync: (candidate) =>
				candidate === nested ? escaped : fs.realpathSync.native(candidate),
		});

		expect(result.files).toEqual([]);
		expect(result.errors).toContain(
			'refusing path outside repository scripts/nested',
		);
	});

	test('fails closed on an oversized shell file without reading it unbounded', async () => {
		const repo = canonicalMkdtemp('bash-portability-file-bound-');
		roots.push(repo);
		git(repo, 'init', '-q', '-b', 'main');
		const scripts = path.join(repo, 'scripts');
		fs.mkdirSync(scripts);
		fs.writeFileSync(
			path.join(scripts, 'huge.sh'),
			Buffer.alloc(4 * 1024 * 1024 + 1, 0x20),
		);

		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => output.push(args.join(' '));
		try {
			expect(await main(repo)).toBe(1);
		} finally {
			console.log = originalLog;
		}
		expect(output.join('\n')).toContain('shell file exceeds 4194304 bytes');
	});
});
