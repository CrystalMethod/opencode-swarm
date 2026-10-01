import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	detectTestFramework,
	resolveMavenModuleDir,
	test_runner,
} from '../../../src/tools/test-runner';

const originalBunSpawn = _internals.bunSpawn;
const originalIsCommandAvailable = _internals.isCommandAvailable;
const originalExistsSync = _internals.existsSync;
const originalReaddirSync = _internals.readdirSync;

let spawnCalls: Array<{ cmd: string[]; opts: { cwd?: string } }> = [];

function mockBunSpawn(
	cmd: string[],
	opts: { cwd?: string },
): ReturnType<typeof _internals.bunSpawn> {
	spawnCalls.push({ cmd, opts });
	return {
		stdout: new ReadableStream({
			start(controller) {
				controller.close();
			},
		}),
		stderr: new ReadableStream({
			start(controller) {
				controller.close();
			},
		}),
		exited: Promise.resolve(0),
		exitCode: 0,
		kill: () => {},
	} as unknown as ReturnType<typeof _internals.bunSpawn>;
}

function createTempDir(): string {
	return fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-maven-nested-')),
	);
}

function createFile(dir: string, filePath: string, content = ''): void {
	const fullPath = path.join(dir, filePath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, content);
}

describe('nested Maven module detection and execution', () => {
	let tempDir: string;
	const tempDirs: string[] = [];

	beforeEach(() => {
		tempDir = createTempDir();
		tempDirs.push(tempDir);
		spawnCalls = [];
		_internals.bunSpawn = mockBunSpawn;
		_internals.isCommandAvailable = () => true;
	});

	afterEach(() => {
		_internals.bunSpawn = originalBunSpawn;
		_internals.isCommandAvailable = originalIsCommandAvailable;
		_internals.existsSync = originalExistsSync;
		_internals.readdirSync = originalReaddirSync;
		for (const dir of tempDirs) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
		tempDirs.length = 0;
	});

	describe('end-to-end default dispatch', () => {
		let priorAllowFullSuite: string | undefined;

		beforeEach(() => {
			priorAllowFullSuite = process.env.SWARM_ALLOW_FULL_SUITE;
			process.env.SWARM_ALLOW_FULL_SUITE = '1';
		});

		afterEach(() => {
			if (priorAllowFullSuite === undefined) {
				delete process.env.SWARM_ALLOW_FULL_SUITE;
			} else {
				process.env.SWARM_ALLOW_FULL_SUITE = priorAllowFullSuite;
			}
		});

		test('scope:all file-less runs mvn test from the nested module dir', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			await test_runner.execute({ scope: 'all' }, { directory: tempDir });

			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].cmd).toEqual(['mvn', 'test']);
			expect(spawnCalls[0].opts.cwd).toBe(path.join(tempDir, 'backend'));
		});

		test('scope:all prefers ./mvnw when mvn is not on PATH', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');
			createFile(tempDir, 'backend/mvnw', '#!/bin/sh\n');
			_internals.isCommandAvailable = () => false;

			await test_runner.execute({ scope: 'all' }, { directory: tempDir });

			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].cmd).toEqual(['./mvnw', 'test']);
			expect(spawnCalls[0].opts.cwd).toBe(path.join(tempDir, 'backend'));
		});

		test('scope:all forwards targets as -Dtest in the module dir', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			await test_runner.execute(
				{ scope: 'all', targets: ['ComdirectOAuthClientFetchSessionTest'] },
				{ directory: tempDir },
			);

			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].cmd).toEqual([
				'mvn',
				'test',
				'-Dtest=ComdirectOAuthClientFetchSessionTest',
			]);
			expect(spawnCalls[0].opts.cwd).toBe(path.join(tempDir, 'backend'));
		});
	});

	describe('convention-scope structured error', () => {
		test('Java test file without targets returns class-based error', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');
			createFile(
				tempDir,
				'backend/src/test/java/FooTest.java',
				'class FooTest {}',
			);

			const result = await test_runner.execute(
				{ scope: 'convention', files: ['backend/src/test/java/FooTest.java'] },
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain(
				'Framework "maven" does not support targeted test-file execution',
			);
			expect(parsed.message).toContain('class-based');
		});
	});

	describe('scope:target root resolution', () => {
		test('native target execution stays rooted at the project root', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');
			createFile(tempDir, 'go.mod', 'module example\n\ngo 1.21');
			createFile(
				tempDir,
				'pkg/foo_test.go',
				'package pkg\nfunc TestFoo(t *testing.T) {}',
			);

			await test_runner.execute(
				{
					scope: 'target',
					native_target: {
						framework: 'go-test',
						name: 'TestFoo',
						path: 'pkg',
					},
				},
				{ directory: tempDir },
			);

			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].opts.cwd).toBe(tempDir);
		});
	});

	describe('resolveMavenModuleDir', () => {
		test('walks up from a Java test file through a two-level nested pom', () => {
			createFile(tempDir, 'services/backend/pom.xml', '<project/>');
			createFile(tempDir, 'services/backend/src/test/java/FooTest.java', '');

			const result = resolveMavenModuleDir(tempDir, [
				'services/backend/src/test/java/FooTest.java',
			]);

			expect(result).toBe(path.join(tempDir, 'services/backend'));
		});

		test('one-level probe with no files returns the module dir', () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			const result = resolveMavenModuleDir(tempDir);

			expect(result).toBe(path.join(tempDir, 'backend'));
		});

		test('returns null when no nested pom exists', () => {
			const result = resolveMavenModuleDir(tempDir);

			expect(result).toBeNull();
		});

		test('ignores a pom.xml above the project root', () => {
			const parentDir = path.dirname(tempDir);
			createFile(tempDir, 'src/test/java/FooTest.java', '');
			fs.writeFileSync(path.join(parentDir, 'pom.xml'), '<project/>');

			const result = resolveMavenModuleDir(tempDir, [
				'src/test/java/FooTest.java',
			]);

			expect(result).toBeNull();
		});

		test('drops outside-root file paths and returns null when no in-root file remains', () => {
			const otherDir = createTempDir();
			tempDirs.push(otherDir);
			createFile(tempDir, 'backend/pom.xml', '<project/>');
			createFile(otherDir, 'src/test/java/FooTest.java', '');

			const result = resolveMavenModuleDir(tempDir, [
				path.join(otherDir, 'src/test/java/FooTest.java'),
			]);

			expect(result).toBeNull();
		});

		test('deterministic tie-break picks the first directory alphabetically', () => {
			createFile(tempDir, 'zeta/pom.xml', '<project/>');
			createFile(tempDir, 'alpha/pom.xml', '<project/>');

			const result = resolveMavenModuleDir(tempDir);

			expect(result).toBe(path.join(tempDir, 'alpha'));
		});

		test('root-level pom detector wins over the nested fallback', async () => {
			createFile(tempDir, 'pom.xml', '<project/>');
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			const result = await detectTestFramework(tempDir);

			expect(result).toBe('maven');
		});
	});

	describe('detectTestFramework nested fallback', () => {
		test('falls back to maven when mvn is on PATH and no mvnw exists', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			const result = await detectTestFramework(tempDir);

			expect(result).toBe('maven');
		});

		test('prefers mvnw in the module dir when mvn is unavailable', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');
			createFile(tempDir, 'backend/mvnw', '#!/bin/sh\n');
			_internals.isCommandAvailable = () => false;

			const result = await detectTestFramework(tempDir);

			expect(result).toBe('maven');
		});

		test('Windows mvnw.cmd preference without mvn on PATH', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');
			createFile(tempDir, 'backend/mvnw.cmd', '');
			_internals.isCommandAvailable = () => false;
			const originalPlatform = process.platform;

			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });
				const result = await detectTestFramework(tempDir);
				expect(result).toBe('maven');
			} finally {
				Object.defineProperty(process, 'platform', {
					value: originalPlatform,
				});
			}
		});
	});

	describe('file-less scope guards with nested Maven detection', () => {
		test('scope=convention with no files and no targets returns the explicit guard error', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			const result = await test_runner.execute(
				{ scope: 'convention' },
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain(
				'scope "convention", "graph", and "impact" require explicit files or targets array',
			);
			expect(spawnCalls.length).toBe(0);
		});

		test('scope=convention with targets only does not crash and returns structured error for maven', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			const result = await test_runner.execute(
				{ scope: 'convention', targets: ['SomeTest'] },
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.framework).toBe('maven');
			expect(parsed.error).toContain(
				'Provided files contain no recognized source files or direct test files',
			);
			expect(spawnCalls.length).toBe(0);
		});

		test('scope=graph with targets only does not crash and returns structured error for maven', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			const result = await test_runner.execute(
				{ scope: 'graph', targets: ['SomeTest'] },
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.framework).toBe('maven');
			expect(parsed.error).toContain(
				'Provided files contain no source files with recognized extensions',
			);
			expect(spawnCalls.length).toBe(0);
		});

		test('scope=impact with targets only does not crash and returns structured error for maven', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			const result = await test_runner.execute(
				{ scope: 'impact', targets: ['SomeTest'] },
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.framework).toBe('maven');
			expect(parsed.error).toContain(
				'Provided files contain no source files with recognized extensions',
			);
			expect(spawnCalls.length).toBe(0);
		});
	});
});
