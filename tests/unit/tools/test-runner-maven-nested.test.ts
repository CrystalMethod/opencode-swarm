import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	detectTestFramework,
	resolveMavenModuleDir,
	test_runner,
} from '../../../src/tools/test-runner';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

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
	return canonicalMkdtemp('test-runner-maven-nested-');
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

		test('scope:all stays at root when root pom.xml exists (aggregator reactor)', async () => {
			createFile(tempDir, 'pom.xml', '<project/>');
			createFile(tempDir, 'backend/pom.xml', '<project/>');
			createFile(
				tempDir,
				'backend/src/test/java/FooTest.java',
				'class FooTest {}',
			);

			await test_runner.execute({ scope: 'all' }, { directory: tempDir });

			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].cmd).toEqual(['mvn', 'test']);
			expect(spawnCalls[0].opts.cwd).toBe(tempDir);
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
			const leakRoot = canonicalMkdtemp('leak-');
			tempDirs.push(leakRoot);
			const projDir = path.join(leakRoot, 'proj');
			fs.mkdirSync(projDir, { recursive: true });
			createFile(projDir, 'src/test/java/FooTest.java', '');
			fs.writeFileSync(path.join(leakRoot, 'pom.xml'), '<project/>');

			const result = resolveMavenModuleDir(projDir, [
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

		// Precedence verification (F-3b): In test-runner.ts, detectJavaMaven(baseDir)
		// runs BEFORE detectGradle and detectDotnetTest (enforcing Maven-before-dotnet order),
		// and well before resolveMavenModuleDir. detectJavaMaven only checks existsSync(pom.xml),
		// while detectDotnetTest calls readdirSync(cwd) to scan for a .csproj and
		// resolveMavenModuleDir's file-less probe also calls readdirSync on the
		// probe root. When a root pom.xml exists, detectJavaMaven returns early and
		// neither the dotnet detector nor the nested probe is reached — so
		// readdirSync must never be called with the probe root. Swapping the
		// maven/dotnet order makes detectDotnetTest read the root dir first and
		// this assertion fails.
		test('root pom wins before the dotnet detector (readdir never probes root)', async () => {
			createFile(tempDir, 'pom.xml', '<project/>');
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			const readdirArgs: string[] = [];
			const origReaddir = _internals.readdirSync;
			_internals.readdirSync = ((p: fs.PathLike, options?: unknown) => {
				readdirArgs.push(p.toString());
				return origReaddir(p as any, options as any);
			}) as unknown as typeof _internals.readdirSync;

			try {
				const result = await detectTestFramework(tempDir);
				expect(result).toBe('maven');
				// Probe root argument (tempDir) must never be read by readdirSync
				// when root pom exists: detectJavaMaven returns early without
				// triggering resolveMavenModuleDir's probe or detectDotnetTest.
				expect(readdirArgs).not.toContain(path.resolve(tempDir));
			} finally {
				_internals.readdirSync = origReaddir;
			}
		});

		test('root pom keeps scope:all spawn cwd at root with nested backend/pom.xml', async () => {
			createFile(tempDir, 'pom.xml', '<project/>');
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			const priorEnv = process.env.SWARM_ALLOW_FULL_SUITE;
			process.env.SWARM_ALLOW_FULL_SUITE = '1';
			try {
				await test_runner.execute({ scope: 'all' }, { directory: tempDir });
				expect(spawnCalls.length).toBe(1);
				expect(spawnCalls[0].opts.cwd).toBe(tempDir);
			} finally {
				if (priorEnv === undefined) {
					delete process.env.SWARM_ALLOW_FULL_SUITE;
				} else {
					process.env.SWARM_ALLOW_FULL_SUITE = priorEnv;
				}
			}
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

	describe('F-3c wrapper and executable argv table', () => {
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

		const cases = [
			{
				name: 'win32 with both mvnw and mvnw.cmd yields mvnw.cmd',
				platform: 'win32' as const,
				files: ['mvnw', 'mvnw.cmd'],
				expected: ['mvnw.cmd', 'test'],
			},
			{
				name: 'posix with both mvnw and mvnw.cmd yields ./mvnw',
				platform: 'linux' as const,
				files: ['mvnw', 'mvnw.cmd'],
				expected: ['./mvnw', 'test'],
			},
			{
				name: 'posix with mvnw only yields ./mvnw',
				platform: 'linux' as const,
				files: ['mvnw'],
				expected: ['./mvnw', 'test'],
			},
			{
				name: 'neither wrapper yields mvn',
				platform: 'linux' as const,
				files: [],
				expected: ['mvn', 'test'],
			},
			{
				name: 'win32 with lone mvnw.cmd yields mvnw.cmd',
				platform: 'win32' as const,
				files: ['mvnw.cmd'],
				expected: ['mvnw.cmd', 'test'],
			},
			{
				name: 'posix with lone mvnw.cmd falls back to mvn',
				platform: 'linux' as const,
				files: ['mvnw.cmd'],
				expected: ['mvn', 'test'],
			},
		];

		for (const tc of cases) {
			test(tc.name, async () => {
				const originalPlatform = process.platform;
				const originalBackend = process.env.SWARM_LANG_BACKEND;
				try {
					Object.defineProperty(process, 'platform', { value: tc.platform });

					// Test default dispatch backend
					delete process.env.SWARM_LANG_BACKEND;
					const dispatchDir = createTempDir();
					tempDirs.push(dispatchDir);
					createFile(dispatchDir, 'pom.xml', '<project/>');
					for (const file of tc.files) {
						createFile(dispatchDir, file, '');
					}
					spawnCalls = [];
					await test_runner.execute({ scope: 'all' }, { directory: dispatchDir });
					expect(spawnCalls.length).toBe(1);
					expect(spawnCalls[0].cmd).toEqual(tc.expected);

					// Test legacy backend
					process.env.SWARM_LANG_BACKEND = 'legacy';
					const legacyDir = createTempDir();
					tempDirs.push(legacyDir);
					createFile(legacyDir, 'pom.xml', '<project/>');
					for (const file of tc.files) {
						createFile(legacyDir, file, '');
					}
					spawnCalls = [];
					await test_runner.execute({ scope: 'all' }, { directory: legacyDir });
					expect(spawnCalls.length).toBe(1);
					expect(spawnCalls[0].cmd).toEqual(tc.expected);
				} finally {
					Object.defineProperty(process, 'platform', { value: originalPlatform });
					if (originalBackend === undefined) {
						delete process.env.SWARM_LANG_BACKEND;
					} else {
						process.env.SWARM_LANG_BACKEND = originalBackend;
					}
				}
			});
		}
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
