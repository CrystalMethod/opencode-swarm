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

function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

describe('mutation_test security path tests', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		tempDir = canonicalMkdtemp('mutation-security-paths-');
		realFs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
		realFs.mkdirSync(path.join(tempDir, 'tests'), { recursive: true });
		for (const [file, content] of [
			['src/test.ts', 'const x = 1;\n'],
			['src/valid.ts', 'const value = 1;\n'],
			['src/also-valid.ts', 'const value = 1;\n'],
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

	test('ATTACK: rejects path traversal attempt with ../etc/passwd', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = '../../../etc/passwd';

		// @ts-expect-error — security test bypasses type checking
		const result = await mutation_test.execute(args, {
			directory: tempDir,
		} as never);

		expectFailClosed(result);
	});

	test('ATTACK: rejects path traversal attempt with ..\\windows\\system32', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = '..\\..\\..\\windows\\system32\\config\\sam';

		// @ts-expect-error — security test bypasses type checking
		const result = await mutation_test.execute(args, {
			directory: tempDir,
		} as never);

		expectFailClosed(result);
	});

	test('ATTACK: handles empty string filePath gracefully', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = '';

		// @ts-expect-error — security test bypasses type checking
		const result = await mutation_test.execute(args, {
			directory: tempDir,
		} as never);

		expectFailClosed(result);
	});

	test('ATTACK: handles numeric filePath without crashing (coerced to string)', async () => {
		const args = createBaseArgs();
		// @ts-expect-error - intentionally passing invalid type
		args.patches[0].filePath = 12345;

		// @ts-expect-error — security test bypasses type checking
		await mutation_test.execute(args, { directory: tempDir } as never);

		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	test('ATTACK: handles object filePath without crashing (coerced to string)', async () => {
		const args = createBaseArgs();
		// @ts-expect-error - intentionally passing invalid type
		args.patches[0].filePath = { malicious: 'object' };

		// @ts-expect-error — security test bypasses type checking
		await mutation_test.execute(args, { directory: tempDir } as never);

		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	test('ATTACK: handles null filePath without crashing (coerced to string)', async () => {
		const args = createBaseArgs();
		// @ts-expect-error - intentionally passing invalid type
		args.patches[0].filePath = null;

		// @ts-expect-error — security test bypasses type checking
		await mutation_test.execute(args, { directory: tempDir } as never);

		expect(mockExecuteMutationSuite).toHaveBeenCalled();
	});

	test('ATTACK: handles null byte injection in filePath', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = '/etc/passwd\x00malicious';

		// @ts-expect-error — security test bypasses type checking
		const result = await mutation_test.execute(args, {
			directory: tempDir,
		} as never);

		expectFailClosed(result);
	});

	test('ATTACK: handles extremely long filePath without crashing', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = 'a'.repeat(100000);

		// @ts-expect-error — security test bypasses type checking
		const result = await mutation_test.execute(args, {
			directory: tempDir,
		} as never);

		expectFailClosed(result);
	});

	test('ATTACK: handles absolute path traversal attempt', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = '/absolute/../../../etc/passwd';

		// @ts-expect-error — security test bypasses type checking
		const result = await mutation_test.execute(args, {
			directory: tempDir,
		} as never);

		expectFailClosed(result);
	});

	test('ATTACK: handles Unicode path traversal attempt', async () => {
		const args = createBaseArgs();
		args.patches[0].filePath = '../../../etc/🎄';

		// @ts-expect-error — security test bypasses type checking
		const result = await mutation_test.execute(args, {
			directory: tempDir,
		} as never);

		expectFailClosed(result);
	});

	test('ATTACK: handles mixed legitimate and traversal paths', async () => {
		const args = createBaseArgs();
		args.patches = [
			{
				id: 'legit-1',
				filePath: 'src/valid.ts',
				functionName: 'testFn',
				mutationType: 'off_by_one' as const,
				patch: 'dummy',
			},
			{
				id: 'traversal-2',
				filePath: '../../../root/.ssh/id_rsa',
				functionName: 'testFn',
				mutationType: 'off_by_one' as const,
				patch: 'dummy',
			},
			{
				id: 'legit-2',
				filePath: 'src/also-valid.ts',
				functionName: 'testFn',
				mutationType: 'off_by_one' as const,
				patch: 'dummy',
			},
		];

		mockReadFileSync.mockImplementation((filePath: string) => {
			if (String(filePath).includes('..')) {
				throw new Error('Access denied: path traversal detected');
			}
			return 'const x = 1;';
		});

		// @ts-expect-error — security test bypasses type checking
		const result = await mutation_test.execute(args, {
			directory: tempDir,
		} as never);

		expectFailClosed(result);
	});
});
