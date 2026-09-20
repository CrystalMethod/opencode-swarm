import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	__seedGlabExecutableForTests,
	_internals,
	describeGlabResolution,
	GLAB_BINARY_ENV_VAR,
	GLAB_VERSION_PATTERN,
	resetGlabExecutableCache,
	resolveGlabExecutable,
	windowsGlabAbsoluteCandidates,
} from '../../../src/utils/glab-executable';

/**
 * Issue #2733: the glab resolver must match the gh resolver's contract
 * (tests/unit/utils/gh-executable.test.ts is the twin) — absolute-candidate
 * ordering, absoluteness requirement, `glab --version` probe, bounded budget,
 * caching, bare-'glab' terminal fallback, never throws. Uses the _internals
 * DI seam; no mock.module.
 */
describe('glab resolver parity (#2733)', () => {
	const realInternals = { ..._internals };
	const probes: Array<{ cmd: string; args: string[] }> = [];
	const winSep = String.fromCharCode(92);

	// A real, stat-able regular file stands in for the glab binary so the
	// stat gate passes and the version probe runs deterministically on every
	// host — the spawnSync stub decides acceptance, not the filesystem.
	const standInBinary = path.resolve('package.json');

	beforeEach(() => {
		probes.length = 0;
		resetGlabExecutableCache();
		_internals.env = () => ({ PATH: '' }) as NodeJS.ProcessEnv;
		_internals.now = () => 0;
		_internals.spawnSync = ((cmd: string, args: string[]) => {
			probes.push({ cmd, args });
			return {
				status: 0,
				stdout: Buffer.from('glab version 1.65.0 (2025-01-01)\n'),
				stderr: Buffer.from(''),
				pid: 1,
				output: [],
				error: undefined,
			} as ReturnType<typeof _internals.spawnSync>;
		}) as typeof _internals.spawnSync;
	});

	afterEach(() => {
		Object.assign(_internals, realInternals);
	});

	test('GLAB_BINARY_ENV_VAR is the documented env escape hatch', () => {
		expect(GLAB_BINARY_ENV_VAR).toBe('OPENCODE_SWARM_GLAB_BINARY');
	});

	test('GLAB_VERSION_PATTERN anchors to glab version output only', () => {
		expect(GLAB_VERSION_PATTERN.test('glab version 1.65.0 (2025-01-01)')).toBe(
			true,
		);
		expect(GLAB_VERSION_PATTERN.test('gh version 2.74.0')).toBe(false);
		expect(GLAB_VERSION_PATTERN.test('not really glab')).toBe(false);
		expect(GLAB_VERSION_PATTERN.test('xglab version 1.2')).toBe(false);
	});

	test('windowsGlabAbsoluteCandidates: absolute glab.exe from env vars, deduped', () => {
		const env = {
			ProgramFiles: 'C:\\Program Files',
			'ProgramFiles(x86)': 'C:\\Program Files (x86)',
			LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
		} as unknown as NodeJS.ProcessEnv;
		expect(windowsGlabAbsoluteCandidates(env)).toEqual([
			path.join('C:\\Program Files', 'GitLab CLI', 'glab.exe'),
			path.join('C:\\Program Files (x86)', 'GitLab CLI', 'glab.exe'),
			path.join('C:\\Users\\dev\\AppData\\Local', 'GitLab CLI', 'glab.exe'),
			path.join(
				'C:\\Users\\dev\\AppData\\Local',
				'Programs',
				'GitLab CLI',
				'glab.exe',
			),
		]);

		// ProgramFiles === ProgramFiles(x86) dedupes to a single candidate.
		const dupEnv = {
			ProgramFiles: 'C:\\PF',
			'ProgramFiles(x86)': 'C:\\PF',
		} as unknown as NodeJS.ProcessEnv;
		expect(windowsGlabAbsoluteCandidates(dupEnv)).toEqual([
			path.join('C:\\PF', 'GitLab CLI', 'glab.exe'),
		]);
	});

	test('windowsGlabAbsoluteCandidates: empty env → no candidates', () => {
		expect(windowsGlabAbsoluteCandidates({} as NodeJS.ProcessEnv)).toEqual([]);
	});

	test('env override wins and is probed first with ["--version"]', () => {
		_internals.platform = () => 'win32';
		_internals.env = () =>
			({
				[GLAB_BINARY_ENV_VAR]: standInBinary,
			}) as unknown as NodeJS.ProcessEnv;

		expect(resolveGlabExecutable()).toBe(standInBinary);
		expect(probes[0]?.cmd).toBe(standInBinary);
		expect(probes[0]?.args).toEqual(['--version']);
	});

	test('version gate: exit 0 but non-glab stdout → bare "glab" fallback', () => {
		_internals.platform = () => 'win32';
		_internals.env = () =>
			({
				[GLAB_BINARY_ENV_VAR]: standInBinary,
			}) as unknown as NodeJS.ProcessEnv;
		// Exit 0 but prints non-glab output — accepted-by-exit-code is the
		// accident class the version pattern gate exists to stop.
		_internals.spawnSync = ((cmd: string) => {
			probes.push({ cmd, args: [] });
			return {
				status: 0,
				stdout: Buffer.from('not really glab'),
				stderr: Buffer.from(''),
				pid: 1,
				output: [],
				error: undefined,
			} as ReturnType<typeof _internals.spawnSync>;
		}) as typeof _internals.spawnSync;

		expect(resolveGlabExecutable()).toBe('glab'); // bare fallback
		expect(describeGlabResolution().resolved).toBe(false);
	});

	test('relative PATH candidates are rejected as "not an absolute path"', () => {
		_internals.platform = () => 'win32';
		_internals.env = () =>
			({
				PATH: 'node_modules' + winSep + '.bin',
			}) as NodeJS.ProcessEnv;

		expect(resolveGlabExecutable()).toBe('glab');
		expect(
			describeGlabResolution().attempts.some(
				(a) => a.reason === 'not an absolute path',
			),
		).toBe(true);
	});

	test('darwin and linux have absolute platform candidates', () => {
		for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
			resetGlabExecutableCache();
			_internals.platform = () => platform;
			_internals.env = () => ({ PATH: '' }) as NodeJS.ProcessEnv;
			resolveGlabExecutable();
			const sources = describeGlabResolution().attempts.map((a) => a.source);
			expect(sources).toContain('platform');
		}
	});

	test('budget exhaustion returns the bare fallback and stops the walk early', () => {
		_internals.platform = () => 'linux';
		const manyDirs = Array.from({ length: 30 }, (_, i) => `/opt/d${i}`);
		_internals.env = () =>
			({
				PATH: manyDirs.join(':'),
			}) as NodeJS.ProcessEnv;
		let clock = 0;
		_internals.now = () => {
			clock += 600; // every step eats 600ms of the 1000ms budget
			return clock;
		};
		_internals.spawnSync = ((cmd: string) => {
			probes.push({ cmd, args: [] });
			return {
				status: 1,
				stdout: Buffer.from(''),
				stderr: Buffer.from('nope'),
				pid: 1,
				output: [],
				error: undefined,
			} as ReturnType<typeof _internals.spawnSync>;
		}) as typeof _internals.spawnSync;

		expect(resolveGlabExecutable()).toBe('glab');
		// 30+ candidates exist; the budget must stop the walk early.
		expect(describeGlabResolution().attempts.length).toBeLessThan(30);
	});

	test('never throws when spawn throws', () => {
		_internals.platform = () => 'win32';
		_internals.env = () =>
			({
				[GLAB_BINARY_ENV_VAR]: standInBinary,
			}) as unknown as NodeJS.ProcessEnv;
		_internals.spawnSync = (() => {
			throw new Error('boom');
		}) as typeof _internals.spawnSync;

		expect(resolveGlabExecutable()).toBe('glab');
	});

	test('__seedGlabExecutableForTests pre-seeds the cache; reset re-probes (round-trip)', () => {
		_internals.platform = () => 'win32';
		_internals.env = () =>
			({
				[GLAB_BINARY_ENV_VAR]: standInBinary,
			}) as unknown as NodeJS.ProcessEnv;

		__seedGlabExecutableForTests('/seeded/glab');
		expect(resolveGlabExecutable()).toBe('/seeded/glab');
		expect(probes.length).toBe(0); // seeded — zero probe spawns

		resetGlabExecutableCache();
		expect(resolveGlabExecutable()).toBe(standInBinary); // re-probed + accepted
		expect(probes.length).toBe(1);
	});
});
