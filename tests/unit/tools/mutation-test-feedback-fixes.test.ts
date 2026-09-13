import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	type MutationCommandRunner,
	_internals as mutationInternals,
} from '../../../src/mutation/engine';
import { MAX_IMPACT_CACHE_BYTES } from '../../../src/test-impact/analyzer';
import { MAX_SAFE_TEST_FILES } from '../../../src/test-impact/constants';
import { TOOL_MANIFEST } from '../../../src/tools/manifest';
import {
	mutation_test,
	_internals as mutationToolInternals,
} from '../../../src/tools/mutation-test';
import { test_runner } from '../../../src/tools/test-runner';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let tempDir: string;
const originalRunCommand = mutationInternals.runCommand;

const symlinkSupport = (() => {
	const probe = canonicalMkdtemp('mutation-feedback-symlink-probe-');
	const target = path.join(probe, 'target');
	try {
		fs.writeFileSync(target, 'probe');
		fs.symlinkSync(target, path.join(probe, 'link'), 'file');
		return true;
	} catch {
		return false;
	} finally {
		fs.rmSync(probe, { recursive: true, force: true });
	}
})();
const originalPathRelative = mutationToolInternals.pathRelative;

function completed(): Awaited<ReturnType<MutationCommandRunner>> {
	return { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
}

function patch(filePath: string): Record<string, unknown> {
	return {
		id: filePath,
		filePath,
		functionName: 'value',
		mutationType: 'return_value',
		patch: `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1 +1 @@\n-value = 1;\n+value = 2;\n`,
	};
}

function execute(args: Record<string, unknown>): Promise<string> {
	return mutation_test.execute({ ...args, working_directory: tempDir }, {
		directory: tempDir,
	} as never) as Promise<string>;
}

async function expectOversizedTrackedFilePreservesCache(
	filePath: string,
): Promise<void> {
	const cacheDir = path.join(tempDir, '.swarm', 'cache');
	const cachePath = path.join(cacheDir, 'impact-map.json');
	fs.mkdirSync(cacheDir, { recursive: true });
	fs.writeFileSync(cachePath, 'old-cache');
	fs.writeFileSync(
		path.join(tempDir, filePath),
		Buffer.alloc(MAX_IMPACT_CACHE_BYTES + 1, 0x78),
	);

	const parsed = JSON.parse(
		await execute({
			patches: [patch('src/value.ts')],
			files: ['tests/selected.test.ts'],
			test_command: ['bun', 'test'],
		}),
	) as Record<string, unknown>;

	expect((parsed.selection as Record<string, unknown>).cacheDisposition).toBe(
		'preserved',
	);
	expect(fs.readFileSync(cachePath, 'utf8')).toBe('old-cache');
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('mutation-feedback-fixes-');
	fs.writeFileSync(
		path.join(tempDir, 'package.json'),
		JSON.stringify({ scripts: { test: 'bun test' } }),
	);
	fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
	fs.mkdirSync(path.join(tempDir, 'tests'), { recursive: true });
	fs.writeFileSync(path.join(tempDir, 'src', 'value.ts'), 'value = 1;\n');
	fs.writeFileSync(
		path.join(tempDir, 'tests', 'selected.test.ts'),
		'selected\n',
	);
	mutationInternals.runCommand = (async () =>
		completed()) as MutationCommandRunner;
});

afterEach(() => {
	mutationInternals.runCommand = originalRunCommand;
	mutationToolInternals.pathRelative = originalPathRelative;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('mutation_test feedback regressions', () => {
	test('host manifest preserves mutation and test-runner acceptance entrypoints', async () => {
		expect(TOOL_MANIFEST.mutation_test()).toBe(mutation_test);
		expect(TOOL_MANIFEST.test_runner()).toBe(test_runner);
		const mutationRaw = await TOOL_MANIFEST.mutation_test().execute(
			{
				patches: [patch('src/value.ts')],
				files: ['tests/selected.test.ts'],
				test_command: ['bun', 'test'],
			},
			{ directory: tempDir } as never,
		);
		const mutationResult = JSON.parse(mutationRaw) as Record<string, unknown>;
		expect(mutationResult.success).toBe(true);
		expect(mutationResult.evaluable).toBe(true);

		const raw = await TOOL_MANIFEST.test_runner().execute(
			{
				scope: 'graph',
				files: Array.from(
					{ length: MAX_SAFE_TEST_FILES + 1 },
					(_, index) => `src/source-${index}.ts`,
				),
			},
			{ directory: tempDir } as never,
		);
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		expect(parsed.outcome).toBe('scope_exceeded');
	});

	test('deduplicates canonical explicit paths while retaining one display spelling', async () => {
		const target = path.join(tempDir, 'tests', 'selected.test.ts');
		const alias = path.join(tempDir, 'tests', 'selected-alias.test.ts');
		const files = ['tests/selected.test.ts'];
		if (symlinkSupport) {
			fs.symlinkSync(target, alias, 'file');
			files.push('tests/selected-alias.test.ts');
		} else {
			// Symlink creation is commonly disabled on Windows CI. Exercise the
			// same canonical-identity path with a lexical alias instead of silently
			// skipping the regression coverage on that host.
			files.push('tests/./selected.test.ts');
		}

		const parsed = JSON.parse(
			await execute({
				patches: [patch('src/value.ts')],
				files,
				test_command: ['bun', 'test'],
			}),
		) as Record<string, unknown>;

		expect((parsed.selection as Record<string, unknown>).testFiles).toEqual([
			'tests/selected.test.ts',
		]);
	});

	test('rejects an absolute relative result from cross-drive containment checks', () => {
		// Before the fix, a Windows cross-drive `path.relative` result such as
		// `D:\\outside\\selected.test.ts` was not recognized as an escape because
		// containment only checked for `..` prefixes.
		let calls = 0;
		mutationToolInternals.pathRelative = ((from, to) => {
			calls++;
			if (calls === 2) return 'D:\\outside\\selected.test.ts';
			return originalPathRelative(from, to);
		}) as typeof mutationToolInternals.pathRelative;

		const result = mutationToolInternals.normalizeWorkspaceFile(
			'tests/selected.test.ts',
			tempDir,
			true,
		);

		expect(result).toEqual({
			error:
				'file path resolves outside the project root: tests/selected.test.ts',
		});
	});

	test('preserves a replacement cache generation during source/test invalidation', async () => {
		const cacheDir = path.join(tempDir, '.swarm', 'cache');
		const cachePath = path.join(cacheDir, 'impact-map.json');
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(cachePath, 'old-cache');
		const selectedTest = path.join(tempDir, 'tests', 'selected.test.ts');
		let command = 0;
		mutationInternals.runCommand = (async ({ args }) => {
			command++;
			if (args[0] === 'apply' && args[1] === '-R') {
				fs.writeFileSync(cachePath, 'concurrent-refresh');
			}
			if (args[0] !== 'apply') fs.writeFileSync(selectedTest, 'changed\n');
			return completed();
		}) as MutationCommandRunner;

		const parsed = JSON.parse(
			await execute({
				patches: [patch('src/value.ts')],
				files: ['tests/selected.test.ts'],
				test_command: ['bun', 'test'],
			}),
		) as Record<string, unknown>;

		expect(command).toBe(3);
		expect((parsed.selection as Record<string, unknown>).cacheDisposition).toBe(
			'preserved',
		);
		expect(fs.readFileSync(cachePath, 'utf8')).toBe('concurrent-refresh');
	});

	test('preserves a concurrent cache refresh without destructive invalidation', async () => {
		const cacheDir = path.join(tempDir, '.swarm', 'cache');
		const cachePath = path.join(cacheDir, 'impact-map.json');
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(cachePath, 'old-cache');
		const selectedTest = path.join(tempDir, 'tests', 'selected.test.ts');
		mutationInternals.runCommand = (async ({ args }) => {
			if (args[0] !== 'apply') {
				fs.writeFileSync(selectedTest, 'changed\n');
				fs.writeFileSync(cachePath, 'concurrent-refresh');
			}
			return completed();
		}) as MutationCommandRunner;

		const parsed = JSON.parse(
			await execute({
				patches: [patch('src/value.ts')],
				files: ['tests/selected.test.ts'],
				test_command: ['bun', 'test'],
			}),
		) as Record<string, unknown>;

		expect((parsed.selection as Record<string, unknown>).cacheDisposition).toBe(
			'preserved',
		);
		expect(fs.readFileSync(cachePath, 'utf8')).toBe('concurrent-refresh');
	});

	test('does not digest an oversized cache generation', async () => {
		const cacheDir = path.join(tempDir, '.swarm', 'cache');
		const cachePath = path.join(cacheDir, 'impact-map.json');
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(cachePath, Buffer.alloc(MAX_IMPACT_CACHE_BYTES + 1, 0x78));
		mutationInternals.runCommand = (async () =>
			completed()) as MutationCommandRunner;

		const parsed = JSON.parse(
			await execute({
				patches: [patch('src/value.ts')],
				files: ['tests/selected.test.ts'],
				test_command: ['bun', 'test'],
			}),
		) as Record<string, unknown>;

		expect((parsed.selection as Record<string, unknown>).cacheDisposition).toBe(
			'unavailable',
		);
		expect(fs.statSync(cachePath).size).toBe(MAX_IMPACT_CACHE_BYTES + 1);
	});

	test('fails closed when a source content digest exceeds the bound', async () => {
		await expectOversizedTrackedFilePreservesCache('src/value.ts');
	});

	test('fails closed when a selected test content digest exceeds the bound', async () => {
		await expectOversizedTrackedFilePreservesCache('tests/selected.test.ts');
	});

	test('bounds sourceFiles evidence to the safe cap plus one sentinel', async () => {
		const patches = Array.from(
			{ length: MAX_SAFE_TEST_FILES + 10 },
			(_, index) => {
				const filePath = `src/value-${index}.ts`;
				fs.writeFileSync(path.join(tempDir, filePath), 'value = 1;\n');
				return patch(filePath);
			},
		);

		const parsed = JSON.parse(
			await execute({
				patches,
				files: ['tests/selected.test.ts'],
				test_command: ['bun', 'test'],
			}),
		) as Record<string, unknown>;
		const selection = parsed.selection as Record<string, unknown>;

		expect(selection.sourceFiles).toHaveLength(MAX_SAFE_TEST_FILES + 1);
		expect(selection.sourceFileCount).toBe(MAX_SAFE_TEST_FILES + 1);
		expect(selection.sourceFilesTruncated).toBe(true);
	});
});
