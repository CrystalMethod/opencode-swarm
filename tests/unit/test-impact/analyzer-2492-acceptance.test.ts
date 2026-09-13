import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	analyzeImpact,
	buildImpactMap,
	loadImpactMap,
	MAX_IMPACT_MAP_REFERENCES,
} from '../../../src/test-impact/analyzer';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let tempDir: string;
let originalLoadImpactMap: typeof _internals.loadImpactMap;

beforeEach(() => {
	tempDir = canonicalMkdtemp('impact-2492-');
	originalLoadImpactMap = _internals.loadImpactMap;
});

afterEach(() => {
	_internals.loadImpactMap = originalLoadImpactMap;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function normalized(filePath: string): string {
	return filePath.replace(/\\/g, '/');
}

describe('issue #2492: impact analysis acceptance', () => {
	test('the unique-test budget ignores duplicate shared edges', async () => {
		const shared = 'tests/shared.test.ts';
		const unique = 'tests/unique.test.ts';
		const impactMap = {
			[path.join(tempDir, 'src', 'a.ts')]: [shared],
			[path.join(tempDir, 'src', 'b.ts')]: [shared],
			[path.join(tempDir, 'src', 'c.ts')]: [unique],
		};
		_internals.loadImpactMap = async () => impactMap;

		const result = await analyzeImpact(
			[
				path.join(tempDir, 'src', 'a.ts'),
				path.join(tempDir, 'src', 'b.ts'),
				path.join(tempDir, 'src', 'c.ts'),
			],
			tempDir,
			2,
		);

		expect(result.impactedTests).toEqual([shared, unique]);
		expect(result.budgetExceeded).toBe(false);
	});

	test('keeps side-effect imports when a later declaration uses from', () => {
		const imports = _internals.extractImports(
			"import './side-effect';\nconst marker = true;\nimport { value } from './later';\n",
		);
		expect(imports).toEqual(['./side-effect', './later']);
	});

	test('keeps from imports when a clause comment contains a semicolon', () => {
		const imports = _internals.extractImports(
			"import { value /* semicolon ; in a comment */ } from './commented';\n",
		);
		expect(imports).toEqual(['./commented']);
	});

	test('ignores comment-only side-effect, require, and re-export syntax', () => {
		const imports = _internals.extractImports(
			[
				"// import './comment-side';",
				"/* require('./comment-require') */",
				"// export { fake } from './comment-reexport';",
				"import './real-side';",
				"const value = require('./real-require');",
				"export { real } from './real-reexport';",
			].join('\n'),
		);
		expect(imports).toEqual([
			'./real-side',
			'./real-require',
			'./real-reexport',
		]);
	});

	test('does not reuse traversal budgets during unrelated-test classification', async () => {
		const changedFile = path.join(tempDir, 'src', 'changed.ts');
		const impactedCount = Math.floor(MAX_IMPACT_MAP_REFERENCES / 2);
		const unrelatedCount = MAX_IMPACT_MAP_REFERENCES - impactedCount;
		const impactMap = {
			[normalized(changedFile)]: Array.from(
				{ length: impactedCount },
				(_, index) => `tests/changed-${index}.test.ts`,
			),
			[normalized(path.join(tempDir, 'src', 'unrelated.ts'))]: Array.from(
				{ length: unrelatedCount },
				(_, index) => `tests/unrelated-${index}.test.ts`,
			),
		};
		_internals.loadImpactMap = async () => impactMap;

		const result = await analyzeImpact([changedFile], tempDir);

		expect(result.budgetExceeded).toBe(false);
		expect(result.impactedTests).toHaveLength(impactedCount);
		expect(result.unrelatedTests).toHaveLength(unrelatedCount);
	});

	test('changing a test import invalidates the impact cache before reuse', async () => {
		const sourceDir = path.join(tempDir, 'src');
		fs.mkdirSync(sourceDir, { recursive: true });
		const foo = path.join(sourceDir, 'foo.ts');
		const bar = path.join(sourceDir, 'bar.ts');
		const testFile = path.join(sourceDir, 'foo.test.ts');
		fs.writeFileSync(foo, 'export const value = 1;\n');
		fs.writeFileSync(bar, 'export const value = 2;\n');
		fs.writeFileSync(testFile, "import { value } from './foo';\n");

		await buildImpactMap(tempDir);
		const oldTestMtime = fs.statSync(testFile).mtimeMs;
		fs.writeFileSync(testFile, "import { value } from './bar';\n");
		// Ensure the mtime-only invalidation signal is unambiguous on coarse filesystems.
		const future = new Date(oldTestMtime + 2_000);
		fs.utimesSync(testFile, future, future);

		const refreshed = await loadImpactMap(tempDir);
		const fooTests = refreshed[normalized(foo)];
		const barTests = refreshed[normalized(bar)];
		expect(fooTests ?? []).not.toContain(normalized(testFile));
		expect(barTests ?? []).toContain(normalized(testFile));
	});

	test('same-size test edits invalidate the cache when mtime is restored', async () => {
		const sourceDir = path.join(tempDir, 'src');
		fs.mkdirSync(sourceDir, { recursive: true });
		const foo = path.join(sourceDir, 'foo.ts');
		const bar = path.join(sourceDir, 'bar.ts');
		const testFile = path.join(sourceDir, 'foo.test.ts');
		fs.writeFileSync(foo, 'export const value = 1;\n');
		fs.writeFileSync(bar, 'export const value = 2;\n');
		const originalContent = "import { value } from './foo';\n";
		const changedContent = "import { value } from './bar';\n";
		expect(Buffer.byteLength(changedContent)).toBe(
			Buffer.byteLength(originalContent),
		);
		fs.writeFileSync(testFile, originalContent);
		const stableMtimeMs = 1_700_000_000_000;
		fs.utimesSync(testFile, stableMtimeMs / 1_000, stableMtimeMs / 1_000);

		await buildImpactMap(tempDir);
		const cachedStat = fs.statSync(testFile);
		fs.writeFileSync(testFile, changedContent);
		fs.utimesSync(testFile, stableMtimeMs / 1_000, stableMtimeMs / 1_000);

		const restoredStat = fs.statSync(testFile);
		expect(restoredStat.size).toBe(cachedStat.size);
		expect(restoredStat.mtimeMs).toBe(cachedStat.mtimeMs);
		const refreshed = await loadImpactMap(tempDir);
		const fooTests = refreshed[normalized(foo)];
		const barTests = refreshed[normalized(bar)];
		expect(fooTests ?? []).not.toContain(normalized(testFile));
		expect(barTests ?? []).toContain(normalized(testFile));
	});
});
