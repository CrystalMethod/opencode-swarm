import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const {
	MAX_SAFE_SOURCE_FILES,
	MAX_SAFE_TEST_FILES,
	test_runner,
	getTestFilesFromConvention,
} = await import('../../../src/tools/test-runner');

function removeTempDir(tempDir: string): void {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup failures; the test result is already determined.
	}
}

describe('test-runner.ts - scope-specific source resolution bounds', () => {
	test('MAX_SAFE_SOURCE_FILES is exported and equals 1', () => {
		expect(MAX_SAFE_SOURCE_FILES).toBe(1);
	});

	test('scope "graph" with 1 source file does NOT trigger source-file guard', async () => {
		const tempDir = canonicalMkdtemp('test-runner-graph-1src-');
		const originalCwd = process.cwd();
		process.chdir(tempDir);
		try {
			fs.writeFileSync('package.json', JSON.stringify({ name: 'no-runner' }));
			fs.mkdirSync('src', { recursive: true });
			fs.writeFileSync('src/utils.ts', 'export const x = 1;');

			const result = await test_runner.execute(
				{ scope: 'graph', files: ['src/utils.ts'] },
				{} as any,
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).not.toContain('accepts at most');
		} finally {
			process.chdir(originalCwd);
			removeTempDir(tempDir);
		}
	}, 15000);

	test('scope "graph" with 2 source files reaches bounded zero-test fallback', async () => {
		const tempDir = canonicalMkdtemp('test-runner-graph-2src-');
		const originalCwd = process.cwd();
		process.chdir(tempDir);
		try {
			fs.writeFileSync(
				'package.json',
				JSON.stringify({
					scripts: { test: 'vitest run' },
					devDependencies: { vitest: '^1.0.0' },
				}),
			);
			fs.mkdirSync('src', { recursive: true });
			fs.writeFileSync('src/a.ts', 'export const a = 1;');
			fs.writeFileSync('src/b.ts', 'export const b = 2;');

			const result = await test_runner.execute(
				{ scope: 'graph', files: ['src/a.ts', 'src/b.ts'] },
				{} as any,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.scope).toBe('convention');
			expect(parsed.outcome).toBe('no_impacted_tests');
			expect(parsed.attempted_scope).toBe('graph');
			expect(parsed.resolution.cap).toBe(MAX_SAFE_TEST_FILES);
			expect(parsed.resolution.evaluable).toBe(false);
		} finally {
			process.chdir(originalCwd);
			removeTempDir(tempDir);
		}
	}, 15000);

	test('scope "graph" with many source files remains admitted with bounded zero-test fallback', async () => {
		const tempDir = canonicalMkdtemp('test-runner-graph-manysrc-');
		const originalCwd = process.cwd();
		process.chdir(tempDir);
		try {
			fs.writeFileSync(
				'package.json',
				JSON.stringify({
					scripts: { test: 'vitest run' },
					devDependencies: { vitest: '^1.0.0' },
				}),
			);
			fs.mkdirSync('src', { recursive: true });
			const manyFiles = Array.from({ length: 20 }, (_, i) => {
				const name = `src/file${i}.ts`;
				fs.writeFileSync(name, `export const val${i} = ${i};`);
				return name;
			});

			const result = await test_runner.execute(
				{ scope: 'graph', files: manyFiles },
				{} as any,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.scope).toBe('convention');
			expect(parsed.outcome).toBe('no_impacted_tests');
			expect(parsed.resolution.sourceFiles).toHaveLength(manyFiles.length);
		} finally {
			process.chdir(originalCwd);
			removeTempDir(tempDir);
		}
	}, 15000);

	test('scope "impact" with 2 source files reaches bounded zero-test fallback', async () => {
		const tempDir = canonicalMkdtemp('test-runner-impact-2src-');
		const originalCwd = process.cwd();
		process.chdir(tempDir);
		try {
			fs.writeFileSync(
				'package.json',
				JSON.stringify({
					scripts: { test: 'vitest run' },
					devDependencies: { vitest: '^1.0.0' },
				}),
			);
			fs.mkdirSync('src', { recursive: true });
			fs.writeFileSync('src/a.ts', 'export const a = 1;');
			fs.writeFileSync('src/b.ts', 'export const b = 2;');

			const result = await test_runner.execute(
				{ scope: 'impact', files: ['src/a.ts', 'src/b.ts'] },
				{} as any,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.scope).toBe('convention');
			expect(parsed.outcome).toBe('no_impacted_tests');
			expect(parsed.attempted_scope).toBe('graph');
			expect(parsed.resolution.cap).toBe(MAX_SAFE_TEST_FILES);
			expect(parsed.resolution.evaluable).toBe(false);
		} finally {
			process.chdir(originalCwd);
			removeTempDir(tempDir);
		}
	}, 15000);

	test('scope "convention" with 2 source files returns scope_exceeded before discovery', async () => {
		const tempDir = canonicalMkdtemp('test-runner-conv-2src-');
		const originalCwd = process.cwd();
		process.chdir(tempDir);
		try {
			fs.writeFileSync(
				'package.json',
				JSON.stringify({
					scripts: { test: 'vitest run' },
					devDependencies: { vitest: '^1.0.0' },
				}),
			);
			fs.mkdirSync('src', { recursive: true });
			fs.writeFileSync('src/a.ts', 'export const a = 1;');
			fs.writeFileSync('src/b.ts', 'export const b = 2;');

			const result = await test_runner.execute(
				{ scope: 'convention', files: ['src/a.ts', 'src/b.ts'] },
				{} as any,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.scope).toBe('convention');
			expect(parsed.outcome).toBe('scope_exceeded');
			expect(parsed.error).toContain('accepts at most');
			expect(parsed.error).toContain('Treat this as SKIP without retry');
			expect(parsed.message).toContain('Call test_runner once per source file');
			expect(parsed.resolution).toMatchObject({
				requestedScope: 'convention',
				effectiveScope: 'convention',
				sourceFiles: ['src/a.ts', 'src/b.ts'],
				resolvedFiles: [],
				cap: MAX_SAFE_TEST_FILES,
				decision: 'scope_exceeded',
				estimate: { count: 0, status: 'not_run' },
				estimateCount: 0,
				estimateStatus: 'not_run',
				fallbackReason: null,
				evaluable: false,
			});
		} finally {
			process.chdir(originalCwd);
			removeTempDir(tempDir);
		}
	}, 15000);

	test('scope "convention" with 1 source file + 1 direct test file does NOT trigger source-file guard', () => {
		const tempDir = canonicalMkdtemp('test-runner-conv-1src1tst-');
		const originalCwd = process.cwd();
		process.chdir(tempDir);
		try {
			fs.mkdirSync('src', { recursive: true });
			fs.writeFileSync('src/utils.ts', 'export const x = 1;');
			fs.writeFileSync(
				'src/utils.test.ts',
				'import { x } from "./utils"; export const v = x;',
			);
			const resolved = getTestFilesFromConvention([
				'src/utils.ts',
				'src/utils.test.ts',
			]).map((p) => p.replace(/\\/g, '/'));
			expect(resolved).toEqual(['src/utils.test.ts']);
		} finally {
			process.chdir(originalCwd);
			removeTempDir(tempDir);
		}
	});

	test('scope "all" blocked error gives bounded "graph" guidance', async () => {
		const result = await test_runner.execute({ scope: 'all' }, {} as any);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.outcome).toBe('error');
		expect(parsed.error).not.toContain('SWARM_ALLOW_FULL_SUITE');
		expect(parsed.message).not.toContain('SWARM_ALLOW_FULL_SUITE');
		expect(parsed.error).toContain('up to 50 normalized source files');
		expect(parsed.message).toContain('up to 50 normalized source files');
	});
});
