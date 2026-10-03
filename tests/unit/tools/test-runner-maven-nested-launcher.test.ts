/**
 * Maven win32 cmd.exe launcher fallback conditions (PR #3021 final critic):
 * - V2-NEW-001: the canonical WRAPPER PATH is checked for cmd.exe
 *   metacharacters, not just the arguments (a module directory named
 *   `m%CMDCMDLINE%&...` must never reach cmd.exe).
 * - M5: `&` alone is rejected.
 * - A target ending in a backslash falls back to plain `mvn` (it would break
 *   the launcher's closing quote).
 *
 * Runs on every OS: process.platform is overridden and the cmd.exe interpreter
 * is a fixture file named cmd.exe injected through windows-batch `_internals`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildMavenTestCommand } from '../../../src/lang/backends/java';
import { _internals, test_runner } from '../../../src/tools/test-runner';
import { _internals as batchInternals } from '../../../src/utils/windows-batch';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realBunSpawn = _internals.bunSpawn;
const realIsCommandAvailable = _internals.isCommandAvailable;
const realComSpec = batchInternals.comSpec;
const realPlatform = process.platform;

type SpawnOpts = { cwd?: string; windowsVerbatimArguments?: boolean };
let spawnCalls: Array<{ cmd: string[]; opts: SpawnOpts }> = [];
let tempDirs: string[] = [];
let savedAllowFullSuite: string | undefined;

function mockBunSpawn(
	cmd: string[],
	opts: SpawnOpts,
): ReturnType<typeof _internals.bunSpawn> {
	spawnCalls.push({ cmd, opts });
	const empty = () =>
		new ReadableStream({
			start(controller) {
				controller.close();
			},
		});
	return {
		stdout: empty(),
		stderr: empty(),
		exited: Promise.resolve(0),
		exitCode: 0,
		kill: () => {},
	} as unknown as ReturnType<typeof _internals.bunSpawn>;
}

function makeDir(): string {
	const dir = canonicalMkdtemp('test-runner-maven-launcher-');
	tempDirs.push(dir);
	return dir;
}

function createFile(dir: string, filePath: string, content = ''): void {
	const fullPath = path.join(dir, filePath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, content);
}

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, 'platform', { value: platform });
}

/** Point the comSpec seam at a fixture cmd.exe; returns its canonical path. */
function useFakeCmdExe(): string {
	const sysDir = makeDir();
	createFile(sysDir, 'cmd.exe');
	const cmdExe = path.join(sysDir, 'cmd.exe');
	batchInternals.comSpec = () => cmdExe;
	return fs.realpathSync(cmdExe);
}

/** A module dir `<project>/<name>` holding pom.xml + mvnw.cmd. */
function moduleWithWrapper(project: string, name: string): string {
	const moduleDir = path.join(project, name);
	createFile(moduleDir, 'pom.xml', '<project/>');
	createFile(moduleDir, 'mvnw.cmd', '@echo off\r\n');
	return moduleDir;
}

/**
 * `%` and `&` are legal in directory names on Windows and POSIX; a host that
 * still refuses them SKIPS the dependent tests with a visible warning.
 */
const canMakeMetaDirs = ((): boolean => {
	const probe = canonicalMkdtemp('maven-launcher-probe-');
	try {
		fs.mkdirSync(path.join(probe, 'm%x'));
		fs.mkdirSync(path.join(probe, 'a&b'));
		return true;
	} catch (error) {
		console.warn(
			`[test-runner-maven-nested-launcher] cannot create directories named with % or &; skipping wrapper-path metacharacter tests: ${String(error)}`,
		);
		return false;
	} finally {
		fs.rmSync(probe, { recursive: true, force: true });
	}
})();

beforeEach(() => {
	spawnCalls = [];
	savedAllowFullSuite = process.env.SWARM_ALLOW_FULL_SUITE;
	process.env.SWARM_ALLOW_FULL_SUITE = '1';
	_internals.bunSpawn = mockBunSpawn;
	_internals.isCommandAvailable = () => true;
});

afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
	_internals.isCommandAvailable = realIsCommandAvailable;
	batchInternals.comSpec = realComSpec;
	setPlatform(realPlatform);
	if (savedAllowFullSuite === undefined) {
		delete process.env.SWARM_ALLOW_FULL_SUITE;
	} else {
		process.env.SWARM_ALLOW_FULL_SUITE = savedAllowFullSuite;
	}
	for (const dir of tempDirs) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
	tempDirs = [];
});

async function runAll(
	dir: string,
): Promise<{ framework?: string; error?: string }> {
	spawnCalls = [];
	return JSON.parse(
		await test_runner.execute({ scope: 'all' }, { directory: dir }),
	);
}

describe('V2-NEW-001: wrapper path metacharacters reject the launcher', () => {
	test.skipIf(!canMakeMetaDirs)(
		'module dirs named with % or & fall back to mvn; a plain name still launches',
		() => {
			const cmdExe = useFakeCmdExe();
			setPlatform('win32');
			const project = makeDir();

			// Control: the plain-named module gets the cmd.exe launcher, so the
			// fallbacks below are not vacuous.
			const plain = moduleWithWrapper(project, 'plain');
			const control = buildMavenTestCommand(plain, []);
			expect(control[0]).toBe(cmdExe);
			expect(control[5]).toBe(
				`call "${fs.realpathSync(path.join(plain, 'mvnw.cmd'))}" "test"`,
			);

			for (const name of ['m%x', 'a&b', 'm%CMDCMDLINE%&mkdir PWNED_DIR&y']) {
				let moduleDir: string;
				try {
					moduleDir = moduleWithWrapper(project, name);
				} catch (error) {
					console.warn(
						`[test-runner-maven-nested-launcher] cannot create module dir "${name}"; skipping that name: ${String(error)}`,
					);
					continue;
				}
				expect(buildMavenTestCommand(moduleDir, [])).toEqual(['mvn', 'test']);
				expect(buildMavenTestCommand(moduleDir, ['FooTest'])).toEqual([
					'mvn',
					'test',
					'-Dtest=FooTest',
				]);
			}
		},
	);

	test.skipIf(!canMakeMetaDirs)(
		'detection does not accept maven through a metacharacter wrapper path',
		async () => {
			useFakeCmdExe();
			setPlatform('win32');
			_internals.isCommandAvailable = (cmd: string) => cmd !== 'mvn';

			for (const name of ['m%x', 'a&b']) {
				const project = makeDir();
				moduleWithWrapper(project, name);
				const parsed = await runAll(project);
				expect(parsed.framework).toBe('none');
				expect(spawnCalls.length).toBe(0);
			}

			// Control: a plain-named wrapper module IS detected through the launcher.
			const project = makeDir();
			const plain = moduleWithWrapper(project, 'plain');
			const parsed = await runAll(project);
			expect(parsed.framework).toBe('maven');
			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].opts.cwd).toBe(plain);
			expect(spawnCalls[0].opts.windowsVerbatimArguments).toBe(true);
		},
	);
});

describe('M5: "&" alone is rejected (validateArgs blocks it upstream)', () => {
	test('a target containing only & falls back to mvn; plain target launches', () => {
		const cmdExe = useFakeCmdExe();
		setPlatform('win32');
		const dir = makeDir();
		createFile(dir, 'pom.xml', '<project/>');
		createFile(dir, 'mvnw.cmd', '@echo off\r\n');

		expect(buildMavenTestCommand(dir, ['a&b'])).toEqual([
			'mvn',
			'test',
			'-Dtest=a&b',
		]);
		expect(buildMavenTestCommand(dir, ['ab'])[0]).toBe(cmdExe);
	});
});

describe('trailing backslash target falls back to plain mvn', () => {
	test('Foo\\ -> mvn on win32; Foo and an inner backslash still launch', () => {
		const cmdExe = useFakeCmdExe();
		setPlatform('win32');
		const dir = makeDir();
		createFile(dir, 'pom.xml', '<project/>');
		createFile(dir, 'mvnw.cmd', '@echo off\r\n');

		expect(buildMavenTestCommand(dir, ['Foo\\'])).toEqual([
			'mvn',
			'test',
			'-Dtest=Foo\\',
		]);
		expect(buildMavenTestCommand(dir, ['Foo'])[0]).toBe(cmdExe);
		expect(buildMavenTestCommand(dir, ['Foo\\Bar'])[0]).toBe(cmdExe);
	});
});
