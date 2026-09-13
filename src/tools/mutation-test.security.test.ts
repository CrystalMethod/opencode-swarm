import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as realFs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir.js';
import type { ToolResult } from './create-tool';

// Mock fs module
const mockReadFileSync = vi.fn();
vi.mock('node:fs', () => ({
	...realFs,
	readFileSync: mockReadFileSync,
}));

// Mock executeMutationSuite
const mockExecuteMutationSuite = vi.fn();
vi.mock('../mutation/engine.js', () => ({
	executeMutationSuite: mockExecuteMutationSuite,
	validateTestCommand: () => null,
}));

import { mutation_test } from './mutation-test';

let tempDir: string;

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

// Helper to extract string from ToolResult
function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

describe('mutation_test security tests', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		tempDir = canonicalMkdtemp('mutation-security-');
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

	/**
	 * Helper to create valid base args
	 */
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

	// =========================================================================
	// ATTACK VECTOR 12: fs.readFileSync throws for directory path
	// =========================================================================
	test('ATTACK: handles directory path instead of file path', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = 'src';

		mockReadFileSync.mockImplementation(() => {
			throw new Error('EISDIR: illegal operation on a directory, read');
		});

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, { directory: tempDir } as never);

		const _parsed = JSON.parse(resultToString(result));
		// Should handle directory read error gracefully
		expectFailClosed(result);
	});

	// =========================================================================
	// SECURITY: verify sourceFiles Map is built from unique filePaths only
	// =========================================================================
	test('SECURITY: sourceFiles Map is built from unique filePaths only', async () => {
		const args = createBaseArgs();
		args.patches = [
			{
				id: '1',
				filePath: 'src/a.ts',
				functionName: 'f',
				mutationType: 't' as any,
				patch: 'p',
			},
			{
				id: '2',
				filePath: 'src/b.ts',
				functionName: 'f',
				mutationType: 't' as any,
				patch: 'p',
			},
			{
				id: '3',
				filePath: 'src/a.ts',
				functionName: 'f',
				mutationType: 't' as any,
				patch: 'p',
			}, // duplicate
		];

		// Mock to handle resolved paths (path.resolve prepends cwd)
		mockReadFileSync.mockImplementation((resolvedPath: string) => {
			// On Windows, path.resolve('C:\\project\\root', 'src/a.ts') gives C:\project\root\src\a.ts
			// On Unix, path.resolve('/project/root', 'src/a.ts') gives /project/root/src/a.ts
			// Extract just the filename part to match
			const filename = resolvedPath.split(/[/\\]/).pop();
			if (filename === 'a.ts') return 'content a';
			if (filename === 'b.ts') return 'content b';
			throw new Error(String(resolvedPath));
		});

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		await tool.execute(args, { directory: tempDir } as never);

		// Verify sourceFiles was called - only unique paths should be read
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
		const mockCalls = mockExecuteMutationSuite.mock.calls;
		const sourceFilesArg = mockCalls[0]![6] as Map<string, string>;

		// Should have only 2 entries (unique paths)
		expect(sourceFilesArg.size).toBe(2);
	});

	// =========================================================================
	// BOUNDARY TEST: Double dot with valid prefix
	// =========================================================================
	test('BOUNDARY: handles double dot in middle of valid path', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = 'src/../src/utils.ts';

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, { directory: tempDir } as never);

		const _parsed = JSON.parse(resultToString(result));
		// Double dot in middle of valid path is legitimate
		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	// =========================================================================
	// SECURITY ASSERTION: executeMutationSuite receives sanitized sourceFiles
	// =========================================================================
	test('SECURITY: executeMutationSuite receives sourceFiles Map with file contents', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = 'src/test.ts';

		mockReadFileSync.mockReturnValue('const original = true;');

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		await tool.execute(args, { directory: tempDir } as never);

		// Verify executeMutationSuite was called
		expect(mockExecuteMutationSuite).toHaveBeenCalled();

		// Get the mock call arguments
		const mockCalls = mockExecuteMutationSuite.mock.calls;
		expect(mockCalls.length).toBeGreaterThan(0);

		// The 7th argument (index 6) is sourceFiles
		const sourceFilesArg = mockCalls[0]![6];
		expect(sourceFilesArg).toBeInstanceOf(Map);
		expect(sourceFilesArg.get('src/test.ts')).toBe('const original = true;');
	});

	// =========================================================================
	// EDGE CASE: All paths are invalid/traversal
	// =========================================================================
	test('EDGE: handles array where all paths fail to read', async () => {
		const args = createBaseArgs();
		args.patches = [
			{
				id: '1',
				filePath: '../../../etc/passwd',
				functionName: 'f',
				mutationType: 't' as any,
				patch: 'p',
			},
			{
				id: '2',
				filePath: '../../../root/.ssh/id_rsa',
				functionName: 'f',
				mutationType: 't' as any,
				patch: 'p',
			},
		];

		mockReadFileSync.mockImplementation(() => {
			throw new Error('Access denied');
		});

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, { directory: tempDir } as never);

		const _parsed = JSON.parse(resultToString(result));
		// Should still call executeMutationSuite with empty sourceFiles
		expectFailClosed(result);
	});

	// =========================================================================
	// EDGE CASE: Source files with special characters in content
	// =========================================================================
	test('EDGE: handles source files with special Unicode content', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = 'src/unicode.ts';

		const unicodeContent = 'const 🎄 = "🎄"; const rtl = "\u202E";';
		mockReadFileSync.mockReturnValue(unicodeContent);

		const tool = mutation_test;
		// @ts-expect-error — security test bypasses type checking
		const result = await tool.execute(args, { directory: tempDir } as never);

		const _parsed = JSON.parse(resultToString(result));
		expect(mockExecuteMutationSuite).toHaveBeenCalled();

		const mockCalls = mockExecuteMutationSuite.mock.calls;
		const sourceFilesArg = mockCalls[0]![6] as Map<string, string>;
		expect(sourceFilesArg.get('src/unicode.ts')).toBe(unicodeContent);
	});
});
