import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as realFs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir.js';
import type { ToolResult } from './create-tool';

const mockReadFileSync = vi.fn();
vi.mock('node:fs', () => ({
	...realFs,
	readFileSync: mockReadFileSync,
}));

const mockExecuteMutationSuite = vi.fn();
vi.mock('../mutation/engine.js', () => ({
	executeMutationSuite: mockExecuteMutationSuite,
	validateTestCommand: () => null,
}));

import { mutation_test } from './mutation-test';

let tempDir: string;

function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

function expectFailClosed(result: ToolResult): void {
	const parsed = JSON.parse(resultToString(result)) as {
		success?: boolean;
		verdict?: string;
		evaluable?: boolean;
		outcome?: string;
	};
	expect(parsed.success).toBe(false);
	expect(parsed.verdict).toBe('skip');
	expect(parsed.evaluable).toBe(false);
	expect(parsed.outcome).toBe('unevaluable');
	expect(mockExecuteMutationSuite).not.toHaveBeenCalled();
}

describe('mutation_test security input limits', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		tempDir = canonicalMkdtemp('mutation-security-inputs-');
		realFs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
		realFs.mkdirSync(path.join(tempDir, 'tests'), { recursive: true });
		for (const [file, content] of [
			['src/test.ts', 'const x = 1;\n'],
			['src/a.ts', 'const a = 1;\n'],
			['src/b.ts', 'const b = 1;\n'],
			['src/utils.ts', 'const value = 1;\n'],
			['src/valid.ts', 'const value = 1;\n'],
			['src/also-valid.ts', 'const value = 1;\n'],
			['src/unicode.ts', 'const value = 1;\n'],
			['test.test.ts', 'test("fixture", () => expect(true).toBe(true));\n'],
		] as const) {
			realFs.writeFileSync(path.join(tempDir, file), content);
		}
		mockReadFileSync.mockImplementation((filePath: string) =>
			realFs.readFileSync(filePath, 'utf8'),
		);
		mockExecuteMutationSuite.mockResolvedValue({
			totalMutants: 10,
			killed: 8,
			survived: 2,
			timeout: 0,
			equivalent: 0,
			skipped: 0,
			errors: 0,
			killRate: 0.8,
			adjustedKillRate: 0.75,
			perFunction: new Map(),
			results: [],
			durationMs: 1000,
			budgetMs: 60000,
			budgetExceeded: false,
			timestamp: new Date().toISOString(),
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		realFs.rmSync(tempDir, { recursive: true, force: true });
	});

	function createBaseArgs() {
		return {
			patches: [
				{
					id: 'test-1',
					filePath: 'src/test.ts',
					functionName: 'testFn',
					mutationType: 'off_by_one' as const,
					patch: '--- a/src/test.ts\n+++ b/src/test.ts\n@@ -1 +1 @@\n',
				},
			],
			files: ['test.test.ts'] as string[],
			test_command: ['bun', 'test'] as string[],
		};
	}

	test('ATTACK: handles large number of patches without memory exhaustion', async () => {
		const args = {
			patches: Array.from({ length: 1000 }, (_, i) => ({
				id: `massive-${i}`,
				filePath: `src/file${i}.ts`,
				functionName: 'testFn' as const,
				mutationType: 'off_by_one' as const,
				patch: 'dummy',
			})),
			files: ['test.test.ts'] as string[],
			test_command: ['bun', 'test'] as string[],
		};
		mockReadFileSync.mockReturnValue('const x = 1;');
		// @ts-expect-error security test bypasses type checking
		const result = await mutation_test.execute(args, {
			directory: tempDir,
		} as never);
		expectFailClosed(result);
	});

	test('ATTACK: handles symlink path traversal', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = 'src/../../symlink-to-etc/passwd';
		mockReadFileSync.mockImplementation(() => {
			throw new Error('ELOOP: symbolic link loop');
		});
		// @ts-expect-error security test bypasses type checking
		const result = await mutation_test.execute(args, {
			directory: tempDir,
		} as never);
		expectFailClosed(result);
	});

	test('ATTACK: handles filePath with shell special characters', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = 'src/file;rm -rf /';
		// @ts-expect-error security test bypasses type checking
		const result = await mutation_test.execute(args, {
			directory: tempDir,
		} as never);
		expectFailClosed(result);
	});

	test('ATTACK: handles undefined filePath without crashing (coerced to string)', async () => {
		const args = createBaseArgs();
		// @ts-expect-error intentionally passing invalid type
		args.patches[0].filePath = undefined;
		// @ts-expect-error security test bypasses type checking
		await mutation_test.execute(args, { directory: tempDir } as never);
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	test('ATTACK: handles binary data as filePath', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = Buffer.from([0x4d, 0x5a, 0x90, 0x00]).toString(
			'utf-8',
		);
		// @ts-expect-error security test bypasses type checking
		const result = await mutation_test.execute(args, {
			directory: tempDir,
		} as never);
		expectFailClosed(result);
	});

	test('ATTACK: handles array as filePath without crashing (coerced to string)', async () => {
		const args = createBaseArgs();
		// @ts-expect-error intentionally passing invalid type
		args.patches[0].filePath = ['../', '../', '../etc/passwd'];
		// @ts-expect-error security test bypasses type checking
		await mutation_test.execute(args, { directory: tempDir } as never);
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});
});
