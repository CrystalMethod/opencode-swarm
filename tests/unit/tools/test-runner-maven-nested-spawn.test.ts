/**
 * Maven wrapper launch argv + spawn options for test_runner (PR #3021 feedback).
 *
 * - F-3c argv table: the dispatch path (Java backend buildTestCommand) and the
 *   legacy switch (SWARM_LANG_BACKEND=legacy) must emit IDENTICAL argv.
 * - W-LAUNCH: on win32, mvnw.cmd is launched through a validated cmd.exe
 *   (`call "<realpath>"`), spawned with windowsVerbatimArguments; any rejected
 *   token / escaping wrapper falls back to plain `mvn` (never a bare mvnw.cmd).
 * - W-WRAPPER: on POSIX only an executable ./mvnw is used; win32 never uses a
 *   POSIX-only mvnw.
 *
 * Platform-specific argv shapes run on EVERY OS: process.platform is
 * overridden and the cmd.exe interpreter is a fixture file named cmd.exe
 * injected through the windows-batch `_internals.comSpec` seam. Only the
 * real-spawn smoke (win32) and the real mode-bit check (POSIX) are gated.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildMavenTestCommand,
	_internals as javaInternals,
} from '../../../src/lang/backends/java';
import { _internals, test_runner } from '../../../src/tools/test-runner';
import {
	_internals as batchInternals,
	isWindowsCommandInterpreterLaunch,
} from '../../../src/utils/windows-batch';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realBunSpawn = _internals.bunSpawn;
const realIsCommandAvailable = _internals.isCommandAvailable;
const realIsExecutableFile = javaInternals.isExecutableFile;
const realComSpec = batchInternals.comSpec;
const realBatchRealpath = batchInternals.realpathSync;
const realPlatform = process.platform;
const ENV_KEYS = ['SWARM_ALLOW_FULL_SUITE', 'SWARM_LANG_BACKEND'] as const;

type SpawnOpts = { cwd?: string; windowsVerbatimArguments?: boolean };
let spawnCalls: Array<{ cmd: string[]; opts: SpawnOpts }> = [];

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

let tempDirs: string[] = [];
let savedEnv: Record<string, string | undefined> = {};

function makeDir(): string {
	const dir = canonicalMkdtemp('test-runner-maven-spawn-');
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

function setBackend(backend: string | undefined): void {
	if (backend === undefined) delete process.env.SWARM_LANG_BACKEND;
	else process.env.SWARM_LANG_BACKEND = backend;
}

/** Point the comSpec seam at a fixture cmd.exe; returns its canonical path. */
function useFakeCmdExe(): string {
	const sysDir = makeDir();
	createFile(sysDir, 'cmd.exe');
	const cmdExe = path.join(sysDir, 'cmd.exe');
	batchInternals.comSpec = () => cmdExe;
	return fs.realpathSync(cmdExe);
}

function launcher(cmdExe: string, wrapper: string, args: string[]): string[] {
	const tail = [wrapper, ...args].map((token) => `"${token}"`).join(' ');
	return [cmdExe, '/d', '/s', '/v:off', '/c', `call ${tail}`];
}

async function runAll(
	dir: string,
	extra: { targets?: string[]; files?: string[] } = {},
): Promise<{ framework?: string; error?: string }> {
	spawnCalls = [];
	return JSON.parse(
		await test_runner.execute({ scope: 'all', ...extra }, { directory: dir }),
	);
}

beforeEach(() => {
	spawnCalls = [];
	savedEnv = {};
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	process.env.SWARM_ALLOW_FULL_SUITE = '1';
	_internals.bunSpawn = mockBunSpawn;
	_internals.isCommandAvailable = () => true;
});

afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
	_internals.isCommandAvailable = realIsCommandAvailable;
	javaInternals.isExecutableFile = realIsExecutableFile;
	batchInternals.comSpec = realComSpec;
	batchInternals.realpathSync = realBatchRealpath;
	setPlatform(realPlatform);
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
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

describe('F-3c wrapper argv table (dispatch and legacy emit identical argv)', () => {
	type Case = {
		name: string;
		platform: NodeJS.Platform;
		files: string[];
		executable?: boolean;
		targets?: string[];
		expected: (dir: string, cmdExe: string) => string[];
	};
	const viaLauncher =
		(args: string[]) =>
		(dir: string, cmdExe: string): string[] =>
			launcher(cmdExe, fs.realpathSync(path.join(dir, 'mvnw.cmd')), args);
	const plain = (argv: string[]) => () => argv;
	const cases: Case[] = [
		{
			name: 'win32 both wrappers -> cmd.exe launcher for mvnw.cmd',
			platform: 'win32',
			files: ['mvnw', 'mvnw.cmd'],
			executable: true,
			expected: viaLauncher(['test']),
		},
		{
			name: 'win32 lone mvnw.cmd -> cmd.exe launcher (absolute realpath)',
			platform: 'win32',
			files: ['mvnw.cmd'],
			expected: viaLauncher(['test']),
		},
		{
			name: 'win32 lone mvnw.cmd with targets -> -Dtest inside the launcher',
			platform: 'win32',
			files: ['mvnw.cmd'],
			targets: ['FooTest#bar', 'BazTest'],
			expected: viaLauncher(['test', '-Dtest=FooTest#bar,BazTest']),
		},
		{
			name: 'win32 POSIX-only mvnw -> mvn (never ./mvnw on win32)',
			platform: 'win32',
			files: ['mvnw'],
			executable: true,
			expected: plain(['mvn', 'test']),
		},
		{
			name: 'posix both, executable mvnw -> ./mvnw',
			platform: 'linux',
			files: ['mvnw', 'mvnw.cmd'],
			executable: true,
			expected: plain(['./mvnw', 'test']),
		},
		{
			name: 'posix executable mvnw only -> ./mvnw',
			platform: 'linux',
			files: ['mvnw'],
			executable: true,
			expected: plain(['./mvnw', 'test']),
		},
		{
			name: 'posix NON-executable mvnw -> mvn',
			platform: 'linux',
			files: ['mvnw'],
			executable: false,
			expected: plain(['mvn', 'test']),
		},
		{
			name: 'posix lone mvnw.cmd -> mvn',
			platform: 'linux',
			files: ['mvnw.cmd'],
			expected: plain(['mvn', 'test']),
		},
		{
			name: 'neither wrapper -> mvn',
			platform: 'linux',
			files: [],
			expected: plain(['mvn', 'test']),
		},
	];

	for (const tc of cases) {
		test(tc.name, async () => {
			const cmdExe = useFakeCmdExe();
			javaInternals.isExecutableFile = () => tc.executable === true;
			setPlatform(tc.platform);
			for (const backend of [undefined, 'legacy']) {
				setBackend(backend);
				const dir = makeDir();
				createFile(dir, 'pom.xml', '<project/>');
				for (const file of tc.files) createFile(dir, file, '');
				await runAll(dir, tc.targets ? { targets: tc.targets } : {});
				const expected = tc.expected(dir, cmdExe);
				expect(spawnCalls.length).toBe(1);
				expect(spawnCalls[0].cmd).toEqual(expected);
				expect(spawnCalls[0].opts.cwd).toBe(dir);
				// The verbatim flag is set exactly for the cmd.exe launcher.
				expect(spawnCalls[0].opts.windowsVerbatimArguments).toBe(
					expected[0] === cmdExe ? true : undefined,
				);
			}
		});
	}
});

describe('W-LAUNCH: rejected launcher falls back to plain mvn', () => {
	function windowsWrapperProject(): string {
		useFakeCmdExe();
		setPlatform('win32');
		const dir = makeDir();
		createFile(dir, 'pom.xml', '<project/>');
		createFile(dir, 'mvnw.cmd', '@echo off\r\n');
		return dir;
	}

	test('targets with cmd.exe metacharacters (| % ^ !) fall back to mvn', async () => {
		const dir = windowsWrapperProject();
		for (const backend of [undefined, 'legacy']) {
			setBackend(backend);
			for (const target of ['Foo|Bar', 'Foo%PATH%', 'Foo^Bar', 'Foo!Bar']) {
				await runAll(dir, { targets: [target] });
				expect(spawnCalls.length).toBe(1);
				expect(spawnCalls[0].cmd).toEqual(['mvn', 'test', `-Dtest=${target}`]);
				expect(spawnCalls[0].opts.windowsVerbatimArguments).toBeUndefined();
			}
		}
	});

	test('a double-quote target (blocked earlier by validateArgs) also falls back', () => {
		const dir = windowsWrapperProject();
		expect(buildMavenTestCommand(dir, ['Foo"Bar'])).toEqual([
			'mvn',
			'test',
			'-Dtest=Foo"Bar',
		]);
		// Control: the same project with a safe target uses the launcher.
		expect(buildMavenTestCommand(dir, ['FooBar'])[1]).toBe('/d');
	});

	test('a wrapper whose realpath escapes the module dir falls back to mvn', async () => {
		const dir = windowsWrapperProject();
		const outside = makeDir();
		// The escaped target must be a real regular file so the ONLY reason for
		// the fallback is the containment check, not a missing-file rejection.
		createFile(outside, 'mvnw.cmd', '@echo off');
		batchInternals.realpathSync = (candidate) =>
			path.basename(candidate) === 'mvnw.cmd'
				? path.join(outside, 'mvnw.cmd')
				: realBatchRealpath(candidate);
		for (const backend of [undefined, 'legacy']) {
			setBackend(backend);
			await runAll(dir);
			expect(spawnCalls[0].cmd).toEqual(['mvn', 'test']);
		}
	});

	test('an unresolvable ComSpec falls back to mvn', async () => {
		const dir = windowsWrapperProject();
		batchInternals.comSpec = () => undefined;
		await runAll(dir);
		expect(spawnCalls[0].cmd).toEqual(['mvn', 'test']);
	});

	test('isWindowsCommandInterpreterLaunch keys on win32 + cmd.exe basename', () => {
		const cmd = ['C:\\Windows\\System32\\CMD.EXE', '/c', 'x'];
		expect(isWindowsCommandInterpreterLaunch(cmd, 'win32')).toBe(true);
		expect(isWindowsCommandInterpreterLaunch(cmd, 'linux')).toBe(false);
		expect(isWindowsCommandInterpreterLaunch(['mvn', 'test'], 'win32')).toBe(
			false,
		);
		expect(isWindowsCommandInterpreterLaunch([], 'win32')).toBe(false);
	});
});

describe('FB-T3: nested module execution through execute', () => {
	test('legacy backend runs the executable ./mvnw from the nested module dir', async () => {
		const dir = makeDir();
		createFile(dir, 'backend/pom.xml', '<project/>');
		createFile(dir, 'backend/mvnw', '#!/bin/sh\n');
		_internals.isCommandAvailable = () => false;
		javaInternals.isExecutableFile = () => true;
		setPlatform('linux');
		setBackend('legacy');

		await runAll(dir);

		expect(spawnCalls.length).toBe(1);
		expect(spawnCalls[0].cmd).toEqual(['./mvnw', 'test']);
		expect(spawnCalls[0].opts.cwd).toBe(path.join(dir, 'backend'));
	});

	test('legacy backend on win32 launches the nested mvnw.cmd via cmd.exe', async () => {
		const cmdExe = useFakeCmdExe();
		const dir = makeDir();
		createFile(dir, 'backend/pom.xml', '<project/>');
		createFile(dir, 'backend/mvnw.cmd', '@echo off\r\n');
		_internals.isCommandAvailable = () => false;
		setPlatform('win32');
		setBackend('legacy');

		await runAll(dir);

		const wrapper = fs.realpathSync(path.join(dir, 'backend', 'mvnw.cmd'));
		expect(spawnCalls[0].cmd).toEqual(launcher(cmdExe, wrapper, ['test']));
		expect(spawnCalls[0].opts.cwd).toBe(path.join(dir, 'backend'));
		expect(spawnCalls[0].opts.windowsVerbatimArguments).toBe(true);
	});

	test('files pick the module that owns them; file-less picks the first sorted', async () => {
		const dir = makeDir();
		createFile(dir, 'm1/pom.xml', '<project/>');
		createFile(dir, 'm2/pom.xml', '<project/>');
		createFile(dir, 'm2/src/test/java/FooTest.java', 'class FooTest {}');
		setPlatform('linux');
		for (const backend of [undefined, 'legacy']) {
			setBackend(backend);
			await runAll(dir, { files: ['m2/src/test/java/FooTest.java'] });
			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].cmd).toEqual(['mvn', 'test']);
			expect(spawnCalls[0].opts.cwd).toBe(path.join(dir, 'm2'));

			await runAll(dir);
			expect(spawnCalls[0].opts.cwd).toBe(path.join(dir, 'm1'));
		}
	});

	test('no pom anywhere: framework none and nothing is spawned', async () => {
		const dir = makeDir();
		createFile(dir, 'src/Main.java', 'class Main {}');
		for (const backend of [undefined, 'legacy']) {
			setBackend(backend);
			const parsed = await runAll(dir);
			expect(parsed.framework).toBe('none');
			expect(parsed.error).toBe('No test framework detected');
		}
		expect(spawnCalls.length).toBe(0);
	});
});

describe('W-WRAPPER: executable-bit check (real filesystem)', () => {
	test('a missing path or a directory is never an executable wrapper', () => {
		const dir = makeDir();
		fs.mkdirSync(path.join(dir, 'mvnw'));
		expect(javaInternals.isExecutableFile(path.join(dir, 'mvnw'))).toBe(false);
		expect(javaInternals.isExecutableFile(path.join(dir, 'absent'))).toBe(
			false,
		);
	});

	test('linux: a default-mode (non-executable) mvnw is not used, falls back to mvn - real isExecutableFile', () => {
		// No isExecutableFile stub and no chmod: a freshly written file has no
		// execute bit (0666 via Windows stat, 0644 on POSIX), so the real mode
		// check must reject it on every OS.
		setPlatform('linux');
		const dir = makeDir();
		createFile(dir, 'pom.xml', '<project/>');
		createFile(dir, 'mvnw', '#!/bin/sh\nexit 0\n');
		expect(buildMavenTestCommand(dir)).toEqual(['mvn', 'test']);
	});

	test.skipIf(process.platform === 'win32')(
		'POSIX: mode 0644 mvnw -> mvn, mode 0755 mvnw -> ./mvnw',
		() => {
			const dir = makeDir();
			createFile(dir, 'mvnw', '#!/bin/sh\nexit 0\n');
			fs.chmodSync(path.join(dir, 'mvnw'), 0o644);
			expect(buildMavenTestCommand(dir)).toEqual(['mvn', 'test']);
			fs.chmodSync(path.join(dir, 'mvnw'), 0o755);
			expect(buildMavenTestCommand(dir)).toEqual(['./mvnw', 'test']);
		},
	);
});

describe('W-LAUNCH real-spawn smoke', () => {
	test.skipIf(process.platform !== 'win32')(
		'win32: execute launches mvnw.cmd through cmd.exe with its arguments',
		async () => {
			// Real ComSpec + real bunSpawn: proves the launcher argv AND the
			// windowsVerbatimArguments spawn option reach the wrapper intact.
			_internals.bunSpawn = realBunSpawn;
			const dir = makeDir();
			createFile(dir, 'pom.xml', '<project/>');
			createFile(
				dir,
				'mvnw.cmd',
				'@echo off\r\necho %~1 %~2> "%~dp0marker.txt"\r\nexit /b 0\r\n',
			);
			const marker = path.join(dir, 'marker.txt');
			for (const backend of [undefined, 'legacy']) {
				setBackend(backend);
				fs.rmSync(marker, { force: true });
				await runAll(dir, { targets: ['FooTest'] });
				expect(fs.existsSync(marker)).toBe(true);
				expect(fs.readFileSync(marker, 'utf-8').trim()).toBe(
					'test -Dtest=FooTest',
				);
			}
		},
		60_000,
	);
});
