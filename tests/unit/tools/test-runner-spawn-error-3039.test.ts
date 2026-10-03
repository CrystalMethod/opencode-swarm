/**
 * Issue #3039: a failed process spawn (`proc.spawnError` set — the bunSpawn
 * value contract, the process never started) must surface as
 * `outcome: "error"` with the spawn reason in `error`, never as
 * `outcome: "regression"` / "Tests failed with 0 failures".
 *
 * Driven through the `_internals.bunSpawn` seam. Framework-independent by
 * construction (single classification site in `runTests`); pinned for two
 * frameworks. Also pins the REAL Bun-runtime failure shape
 * (src/utils/bun-compat.ts spawnCreationFailure: exitCode null, stderr
 * carrying the reason) and the preserving controls (pass / regression /
 * deadline classification unchanged).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals, runTests } from '../../../src/tools/test-runner';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realBunSpawn = _internals.bunSpawn;
const realIsCommandAvailable = _internals.isCommandAvailable;

let tempDir: string;

function streamOf(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			if (text) controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

/** Fake proc carrying a spawn-creation failure (the contract shape). */
function makeSpawnErrorProc(
	reason: string,
	over: Partial<{ exitCode: number | null; stderrText: string }> = {},
): ReturnType<typeof _internals.bunSpawn> {
	return {
		stdout: streamOf(''),
		stderr: streamOf(over.stderrText ?? ''),
		exited: Promise.resolve(1),
		exitCode: over.exitCode ?? 1,
		spawnError: new Error(reason),
		kill: () => {},
		killTree: async () => {},
	} as unknown as ReturnType<typeof _internals.bunSpawn>;
}

function makeProc(
	exitCode: number,
	stdoutText: string,
): ReturnType<typeof _internals.bunSpawn> {
	return {
		stdout: streamOf(stdoutText),
		stderr: streamOf(''),
		exited: Promise.resolve(exitCode),
		exitCode,
		kill: () => {},
		killTree: async () => {},
	} as unknown as ReturnType<typeof _internals.bunSpawn>;
}

const JEST_PASS = 'Tests: 0 failed, 5 passed, 5 total';
const JEST_FAIL = 'Tests: 2 failed, 3 passed, 5 total';

beforeEach(() => {
	tempDir = canonicalMkdtemp('spawn-error-3039-');
	fs.writeFileSync(
		path.join(tempDir, 'package.json'),
		JSON.stringify({ name: 'fixture', scripts: { test: 'jest' } }),
	);
	// The jest command builder gates on command availability; the spawn is
	// faked anyway, so availability is irrelevant to what is classified.
	_internals.isCommandAvailable = () => true;
});

afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
	_internals.isCommandAvailable = realIsCommandAvailable;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('#3039: launch failures classify as error, not regression', () => {
	for (const framework of ['bun', 'gradle'] as const) {
		test(`${framework}: spawnError -> outcome error with the spawn reason`, async () => {
			_internals.bunSpawn = (() =>
				makeSpawnErrorProc(
					'Executable not found in $PATH: "definitely-missing-runner-3039"',
				)) as unknown as typeof _internals.bunSpawn;

			const result = await runTests(
				framework,
				'all',
				[],
				false,
				5000,
				tempDir,
				false,
			);

			expect(result.success).toBe(false);
			expect(result.outcome).toBe('error');
			expect(result.outcome).not.toBe('regression');
			expect(result.error).toContain(
				'Executable not found in $PATH: "definitely-missing-runner-3039"',
			);
		});
	}

	test('real Bun failure shape (exitCode null, stderr carries the reason) classifies the same', async () => {
		const reason = 'posix spawn ENOENT definitely-missing-3039';
		_internals.bunSpawn = (() =>
			makeSpawnErrorProc(reason, {
				exitCode: null,
				stderrText: reason,
			})) as unknown as typeof _internals.bunSpawn;

		const result = await runTests(
			'bun',
			'all',
			[],
			false,
			5000,
			tempDir,
			false,
		);

		expect(result.outcome).toBe('error');
		expect(result.error).toContain(reason);
	});

	test('contract-violating proc (spawnError AND exit 0) is still not a false pass', async () => {
		_internals.bunSpawn = (() =>
			makeSpawnErrorProc('spawn failed anyway', {
				exitCode: 0,
				stdoutText: JEST_PASS,
			})) as unknown as typeof _internals.bunSpawn;

		const result = await runTests(
			'bun',
			'all',
			[],
			false,
			5000,
			tempDir,
			false,
		);

		expect(result.success).toBe(false);
		expect(result.outcome).toBe('error');
	});
});

describe('#3039 preserving controls: existing classification is unchanged', () => {
	test('exit 0 with parseable pass output stays outcome pass', async () => {
		_internals.bunSpawn = (() =>
			makeProc(0, JEST_PASS)) as unknown as typeof _internals.bunSpawn;

		const result = await runTests(
			'jest',
			'all',
			[],
			false,
			5000,
			tempDir,
			false,
		);

		expect(result.success).toBe(true);
		expect(result.outcome).toBe('pass');
	});

	test('exit 1 with parseable failures stays outcome regression', async () => {
		_internals.bunSpawn = (() =>
			makeProc(1, JEST_FAIL)) as unknown as typeof _internals.bunSpawn;

		const result = await runTests(
			'jest',
			'all',
			[],
			false,
			5000,
			tempDir,
			false,
		);

		expect(result.success).toBe(false);
		expect(result.outcome).toBe('regression');
		expect(result.error).toContain('2 failures');
	});

	test('deadline keeps the timeout error/outcome', async () => {
		_internals.bunSpawn = (() =>
			({
				stdout: streamOf(''),
				stderr: streamOf(''),
				exited: new Promise<number>(() => {}),
				exitCode: null,
				kill: () => {},
				killTree: async () => {},
			}) as unknown as ReturnType<
				typeof _internals.bunSpawn
			>) as unknown as typeof _internals.bunSpawn;

		const result = await runTests(
			'jest',
			'all',
			[],
			false,
			200,
			tempDir,
			false,
		);

		expect(result.success).toBe(false);
		expect(result.outcome).toBe('error');
		expect(result.error).toMatch(/timed? ?out|timeout/i);
	});
});
