import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mutation_test } from '../../src/tools/mutation-test';
import { canonicalMkdtemp } from '../helpers/tmpdir.js';

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('mutation_test tool - test_command element type validation', () => {
	test('Array with undefined element → should return error about containing only strings', async () => {
		const args = {
			files: ['test/file.test.ts'],
			test_command: [undefined as unknown as string, 'vitest'],
			patches: [
				{
					id: 'patch-1',
					filePath: 'src/foo.ts',
					functionName: 'foo',
					mutationType: 'off_by_one',
					patch:
						'--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-exports.foo = 1;\n+exports.foo = 2;\n',
				},
			],
		};

		const result = await mutation_test.execute(args, '/cwd');
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe('test_command must contain only strings');
	});

	test('Array with null element → should return error', async () => {
		const args = {
			files: ['test/file.test.ts'],
			test_command: ['npx', null as unknown as string, 'vitest'],
			patches: [
				{
					id: 'patch-1',
					filePath: 'src/foo.ts',
					functionName: 'foo',
					mutationType: 'off_by_one',
					patch:
						'--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-exports.foo = 1;\n+exports.foo = 2;\n',
				},
			],
		};

		const result = await mutation_test.execute(args, '/cwd');
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe('test_command must contain only strings');
	});

	test('Array with number element → should return error', async () => {
		const args = {
			files: ['test/file.test.ts'],
			test_command: ['npx', 42 as unknown as string, 'vitest'],
			patches: [
				{
					id: 'patch-1',
					filePath: 'src/foo.ts',
					functionName: 'foo',
					mutationType: 'off_by_one',
					patch:
						'--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-exports.foo = 1;\n+exports.foo = 2;\n',
				},
			],
		};

		const result = await mutation_test.execute(args, '/cwd');
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe('test_command must contain only strings');
	});

	test('Array with mixed types (string + number + boolean) → should return error', async () => {
		const args = {
			files: ['test/file.test.ts'],
			test_command: [
				'npx',
				123 as unknown as string,
				true as unknown as string,
			],
			patches: [
				{
					id: 'patch-1',
					filePath: 'src/foo.ts',
					functionName: 'foo',
					mutationType: 'off_by_one',
					patch:
						'--- a/src/foo.ts\n+++ a/src/foo.ts\n@@ -1 +1 @@\n-exports.foo = 1;\n+exports.foo = 2;\n',
				},
			],
		};

		const result = await mutation_test.execute(args, '/cwd');
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe('test_command must contain only strings');
	});

	test('Array with all valid strings → should pass validation and return mutation result (not error)', async () => {
		const tempDir = canonicalMkdtemp('mutation-test-command-');
		fs.mkdirSync(path.join(tempDir, '.git'));
		fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, 'test'), { recursive: true });
		fs.writeFileSync(path.join(tempDir, 'src/foo.ts'), 'exports.foo = 1;\n');
		fs.writeFileSync(path.join(tempDir, 'test/file.test.ts'), '');
		const args = {
			files: ['test/file.test.ts'],
			test_command: ['bun', 'test'],
			working_directory: tempDir,
			patches: [
				{
					id: 'patch-1',
					filePath: 'src/foo.ts',
					functionName: 'foo',
					mutationType: 'off_by_one',
					patch:
						'--- a/src/foo.ts\n+++ a/src/foo.ts\n@@ -1 +1 @@\n-exports.foo = 1;\n+exports.foo = 2;\n',
				},
			],
		};

		try {
			const result = await mutation_test.execute(args, { directory: tempDir });
			const parsed = JSON.parse(result);

			// Should pass test_command validation and return mutation result (verdict format)
			// NOT an error format (no success:false, no error field)
			expect(parsed.verdict).toBeDefined();
			expect(parsed.success).toBe(true);
			expect(parsed.error).toBeUndefined();
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
