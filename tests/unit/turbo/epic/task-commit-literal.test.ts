/**
 * Rule 2 literal pathspecs + rename completeness (real git).
 * File: tests/unit/turbo/epic/task-commit-literal.test.ts
 *
 * Previously `stageScopedPaths` passed scope entries to `git ls-files` and
 * `git diff --cached` as PLAIN pathspecs, so a scope entry containing glob
 * metacharacters (`app/[id].tsx`, `src/*.ts`) glob-matched sibling WIP
 * (`app/i.tsx`, `src/sib.ts`), which then got staged and committed into the
 * task's marker commit. And a `git mv` rename with only the destination in
 * scope committed just the addition, leaving the source deletion staged.
 *
 * Isolation: `_internals.sleep` seam restored in `afterEach` (AGENTS.md §7);
 * real git in a canonical temp repo (createSafeTestDir).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	commitTaskCompletion,
	parseRenamePairsZ,
} from '../../../../src/turbo/epic/task-commit';
import { createSafeTestDir } from '../../../helpers/safe-test-dir';

const originals = { ..._internals };

function git(args: string[], cwd: string): string {
	const r = spawnSync('git', args, {
		cwd,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 30_000,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
	});
	if (r.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
	}
	return r.stdout;
}

function headFiles(dir: string): string[] {
	return git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], dir)
		.trim()
		.split('\n')
		.filter((l) => l.length > 0)
		.sort();
}

function write(dir: string, rel: string, content: string): void {
	fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), content);
}

let dir: string;
let cleanup: () => void;

beforeEach(() => {
	({ dir, cleanup } = createSafeTestDir('rule2-literal-'));
	git(['init', '-q', '-b', 'main'], dir);
	git(['config', 'user.email', 'test@example.com'], dir);
	git(['config', 'user.name', 'Test User'], dir);
	git(['config', 'commit.gpgsign', 'false'], dir);
	write(dir, 'README.md', '# seed\n');
	git(['add', 'README.md'], dir);
	git(['commit', '-q', '-m', 'seed'], dir);
	_internals.sleep = async () => {};
});

afterEach(() => {
	Object.assign(_internals, originals);
	cleanup();
});

describe('Rule 2 — regression: glob metacharacters in scope swept sibling WIP (F4)', () => {
	test("scope ['app/[id].tsx'] commits only that file, not sibling app/i.tsx", async () => {
		write(dir, 'app/[id].tsx', 'export const page = 1;\n');
		write(dir, 'app/i.tsx', 'sibling WIP\n');

		const result = await commitTaskCompletion(dir, '4.1', 'route', [
			'app/[id].tsx',
		]);

		expect(result).toMatchObject({ committed: true, reason: 'success' });
		expect(headFiles(dir)).toEqual(['app/[id].tsx']);
		expect(git(['status', '--porcelain', 'app/i.tsx'], dir)).toMatch(
			/^\?\? app\/i\.tsx/,
		);
	});

	test("scope ['src/*.ts'] does not sweep src/sib.ts", async () => {
		write(dir, 'src/*.ts', 'literal star file\n');
		write(dir, 'src/sib.ts', 'sibling WIP\n');

		const result = await commitTaskCompletion(dir, '4.2', 'star', ['src/*.ts']);

		expect(result).toMatchObject({ committed: true, reason: 'success' });
		expect(headFiles(dir)).toEqual(['src/*.ts']);
		expect(git(['status', '--porcelain', 'src/sib.ts'], dir)).toMatch(
			/^\?\? src\/sib\.ts/,
		);
	});

	test('a directory scope still covers files in a new nested directory', async () => {
		write(dir, 'pkg/keep.ts', 'tracked\n');
		git(['add', 'pkg/keep.ts'], dir);
		git(['commit', '-q', '-m', 'track pkg'], dir);
		write(dir, 'pkg/new/deep/a.ts', 'new\n');
		write(dir, 'pkg/keep.ts', 'edited\n');
		write(dir, 'outside.ts', 'not in scope\n');

		const result = await commitTaskCompletion(dir, '4.3', 'dir', ['pkg']);

		expect(result).toMatchObject({ committed: true, reason: 'success' });
		expect(headFiles(dir)).toEqual(['pkg/keep.ts', 'pkg/new/deep/a.ts']);
	});
});

describe('Rule 2 — regression: rename left the source deletion staged (F7a)', () => {
	test('`git mv` with only the destination in scope commits the source deletion too', async () => {
		write(dir, 'src/old-name.ts', 'export const value = 42;\n'.repeat(5));
		git(['add', 'src/old-name.ts'], dir);
		git(['commit', '-q', '-m', 'add old'], dir);
		git(['mv', 'src/old-name.ts', 'src/new-name.ts'], dir);

		const result = await commitTaskCompletion(dir, '4.4', 'rename', [
			'src/new-name.ts',
		]);

		expect(result).toMatchObject({ committed: true, reason: 'success' });
		expect(headFiles(dir)).toEqual(['src/new-name.ts', 'src/old-name.ts']);
		// Nothing left staged: the rename is fully in the commit.
		expect(git(['status', '--porcelain'], dir).trim()).toBe('');
	});

	test('parseRenamePairsZ returns rename pairs and skips copies / plain records', () => {
		const out = 'M\0a.ts\0R100\0old.ts\0new.ts\0C075\0x.ts\0y.ts\0D\0gone.ts\0';
		expect(parseRenamePairsZ(out)).toEqual([['old.ts', 'new.ts']]);
		expect(parseRenamePairsZ('')).toEqual([]);
	});
});
