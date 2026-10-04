/**
 * Issue #3040: on win32 with a `gradlew.bat` wrapper present, BOTH Gradle
 * command routes (the legacy switch in src/tools/test-runner.ts and
 * `defaultBuildTestCommand` in src/lang/default-backend.ts) must emit the
 * contained cmd.exe launcher argv via `resolveContainedWindowsBatchCommand`
 * — never the bare `gradlew.bat` name, which Bun cannot resolve (bare names
 * resolve against PATH only, never the spawn cwd). Fallback chain: a token
 * ending in a backslash or a metacharacter argument falls back to plain
 * `gradle`; POSIX behavior unchanged (`./gradlew` when a gradlew file
 * exists, else `gradle`). Includes a win32-gated real-spawn smoke test that
 * actually launches a fixture wrapper through the real `bunSpawn`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defaultBuildTestCommand } from '../../../src/lang/default-backend';
import { LANGUAGE_REGISTRY } from '../../../src/lang/profiles';
import { _internals, runTests } from '../../../src/tools/test-runner';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realBunSpawn = _internals.bunSpawn;
const realIsCommandAvailable = _internals.isCommandAvailable;
const realPlatform = process.platform;

let tempDir: string;

function emptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.close();
		},
	});
}

function makePassProc(): ReturnType<typeof _internals.bunSpawn> {
	return {
		stdout: emptyStream(),
		stderr: emptyStream(),
		exited: Promise.resolve(0),
		exitCode: 0,
		kill: () => {},
		killTree: async () => {},
	} as unknown as ReturnType<typeof _internals.bunSpawn>;
}

function isCmdExeLauncher(argv: readonly string[]): boolean {
	return (
		argv.length > 0 &&
		path.basename(argv[0]).toLowerCase() === 'cmd.exe' &&
		argv.includes('/c')
	);
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('gradle-launcher-3040-');
	fs.writeFileSync(path.join(tempDir, 'build.gradle'), 'plugins {}\n');
	fs.writeFileSync(
		path.join(tempDir, 'gradlew.bat'),
		'@echo off\r\necho GRADLEW_SMOKE_MARKER %*\r\n',
	);
	_internals.isCommandAvailable = () => true;
	_internals.bunSpawn = (() =>
		makePassProc()) as unknown as typeof _internals.bunSpawn;
});

afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
	_internals.isCommandAvailable = realIsCommandAvailable;
	Object.defineProperty(process, 'platform', { value: realPlatform });
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const javaProfile =
	LANGUAGE_REGISTRY.get('java') ?? LANGUAGE_REGISTRY.getAll()[0]!;

describe('#3040: win32 gradlew.bat routes through the contained launcher', () => {
	test.skipIf(process.platform !== 'win32')(
		'defaultBuildTestCommand emits the launcher, never bare gradlew.bat',
		() => {
			const cmd = defaultBuildTestCommand(javaProfile, 'gradle', [], tempDir, {
				scope: 'all',
				targets: ['com.example.FooTest'],
			});

			expect(cmd).not.toBeNull();
			expect(cmd![0]).not.toBe('gradlew.bat');
			expect(isCmdExeLauncher(cmd!)).toBe(true);
			// The wrapper args ride inside the quoted `call "<abs>" "test" ...`
			// command tail (the launcher's last element), not as standalone
			// argv tokens.
			const tail = cmd![cmd!.length - 1] ?? '';
			expect(tail).toContain('"test"');
			expect(tail).toContain('"com.example.FooTest"');
		},
	);

	test.skipIf(process.platform !== 'win32')(
		'runTests command is the launcher on BOTH backend routes',
		async () => {
			for (const backend of [undefined, 'legacy'] as const) {
				if (backend === undefined) delete process.env.SWARM_LANG_BACKEND;
				else process.env.SWARM_LANG_BACKEND = backend;
				try {
					const result = await runTests(
						'gradle',
						'all',
						[],
						false,
						5000,
						tempDir,
						false,
						['com.example.FooTest'],
					);

					expect(result.command).toBeDefined();
					expect(result.command![0]).not.toBe('gradlew.bat');
					expect(isCmdExeLauncher(result.command!)).toBe(true);
				} finally {
					delete process.env.SWARM_LANG_BACKEND;
				}
			}
		},
	);

	test.skipIf(process.platform !== 'win32')(
		'trailing-backslash target falls back to plain gradle (both routes)',
		() => {
			const cmd = defaultBuildTestCommand(javaProfile, 'gradle', [], tempDir, {
				scope: 'all',
				targets: ['Foo\\'],
			});
			expect(cmd![0]).toBe('gradle');
			expect(isCmdExeLauncher(cmd!)).toBe(false);
		},
	);

	test.skipIf(process.platform !== 'win32')(
		'metacharacter target (helper rejects the token) falls back to plain gradle',
		() => {
			const cmd = defaultBuildTestCommand(javaProfile, 'gradle', [], tempDir, {
				scope: 'all',
				targets: ['Bad%Target'],
			});
			expect(cmd![0]).toBe('gradle');
			expect(isCmdExeLauncher(cmd!)).toBe(false);
		},
	);

	test.skipIf(process.platform !== 'win32')(
		'real-spawn smoke: the launcher actually starts the wrapper (real bunSpawn)',
		async () => {
			_internals.bunSpawn = realBunSpawn;
			const result = await runTests(
				'gradle',
				'all',
				[],
				false,
				30_000,
				tempDir,
				false,
			);

			expect(result.outcome).toBe('pass');
			expect(result.rawOutput).toContain('GRADLEW_SMOKE_MARKER');
		},
	);

	test('no wrapper at all -> plain gradle on every platform', () => {
		const bareDir = path.join(tempDir, 'no-wrapper');
		fs.mkdirSync(bareDir, { recursive: true });
		fs.writeFileSync(path.join(bareDir, 'build.gradle'), 'plugins {}\n');

		const cmd = defaultBuildTestCommand(javaProfile, 'gradle', [], bareDir, {
			scope: 'all',
			targets: ['com.example.FooTest'],
		});

		expect(cmd).toEqual(['gradle', 'test', '--tests', 'com.example.FooTest']);
	});

	test('POSIX shape unchanged: ./gradlew when a gradlew file exists', () => {
		// Emulate POSIX from any host (same Object.defineProperty technique as
		// tests/unit/tools/test-runner-maven-nested-spawn.test.ts). The gradlew
		// fixture is deliberately NOT executable — the historical existsSync
		// chain (not Maven's exec-bit gate) is the pinned behavior.
		Object.defineProperty(process, 'platform', { value: 'linux' });
		try {
			const posixDir = path.join(tempDir, 'posix-wrapper');
			fs.mkdirSync(posixDir, { recursive: true });
			fs.writeFileSync(path.join(posixDir, 'gradlew'), '#!/bin/sh\n');

			const cmd = defaultBuildTestCommand(javaProfile, 'gradle', [], posixDir, {
				scope: 'all',
				targets: ['com.example.FooTest'],
			});

			expect(cmd![0]).toBe('./gradlew');
			expect(isCmdExeLauncher(cmd!)).toBe(false);
		} finally {
			Object.defineProperty(process, 'platform', { value: realPlatform });
		}
	});

	test('win32 with only a POSIX-named gradlew (no .bat) keeps the pre-fix ./gradlew fallthrough', () => {
		// Pins the PRR-004-reviewed case: the historical chain also applies on
		// win32 when gradlew.bat is absent — deliberate pre-#3040 behavior
		// preservation, previously unpinned.
		Object.defineProperty(process, 'platform', { value: 'win32' });
		try {
			const noBatDir = path.join(tempDir, 'win-no-bat');
			fs.mkdirSync(noBatDir, { recursive: true });
			fs.writeFileSync(path.join(noBatDir, 'build.gradle'), 'plugins {}\n');
			fs.writeFileSync(path.join(noBatDir, 'gradlew'), '#!/bin/sh\n');

			const cmd = defaultBuildTestCommand(javaProfile, 'gradle', [], noBatDir, {
				scope: 'all',
			});

			expect(cmd![0]).toBe('./gradlew');
			expect(isCmdExeLauncher(cmd!)).toBe(false);
		} finally {
			Object.defineProperty(process, 'platform', { value: realPlatform });
		}
	});
});
