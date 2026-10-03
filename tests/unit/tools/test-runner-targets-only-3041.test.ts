/**
 * Issue #3041: targets-without-files calls in the convention/graph/impact
 * scopes are rejected UP FRONT with an accurate error (files are required
 * for discovery; targets only filter within a files-driven selection) —
 * never with the misleading files-centric "Provided files contain ..." text
 * that used to fire off the defaulted empty `_files` array. The rejection
 * happens before framework detection (framework: 'none'), on both backends
 * (default dispatch and SWARM_LANG_BACKEND=legacy). Files+targets calls keep
 * passing the guard, and files-provided-but-unrecognized errors are intact.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals, test_runner } from '../../../src/tools/test-runner';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realBunSpawn = _internals.bunSpawn;
const realIsCommandAvailable = _internals.isCommandAvailable;

let outerDir: string;
let projDir: string;
let spawnCount: number;
let priorBackend: string | undefined;

function emptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.close();
		},
	});
}

beforeEach(() => {
	outerDir = canonicalMkdtemp('targets-only-3041-');
	projDir = path.join(outerDir, 'proj');
	fs.mkdirSync(projDir);
	fs.writeFileSync(
		path.join(projDir, 'package.json'),
		JSON.stringify({ name: 'fixture', scripts: { test: 'bun test' } }),
	);
	spawnCount = 0;
	_internals.bunSpawn = (() => {
		spawnCount++;
		return {
			stdout: emptyStream(),
			stderr: emptyStream(),
			exited: Promise.resolve(0),
			exitCode: 0,
			kill: () => {},
			killTree: async () => {},
		} as unknown as ReturnType<typeof _internals.bunSpawn>;
	}) as unknown as typeof _internals.bunSpawn;
	_internals.isCommandAvailable = () => true;
	priorBackend = process.env.SWARM_LANG_BACKEND;
});

afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
	_internals.isCommandAvailable = realIsCommandAvailable;
	if (priorBackend === undefined) delete process.env.SWARM_LANG_BACKEND;
	else process.env.SWARM_LANG_BACKEND = priorBackend;
	fs.rmSync(outerDir, { recursive: true, force: true });
});

describe('#3041: targets-only calls are rejected up front, accurately', () => {
	for (const scope of ['convention', 'graph', 'impact'] as const) {
		for (const backend of [undefined, 'legacy'] as const) {
			test(`scope=${scope} backend=${backend ?? 'dispatch'}: accurate guard error`, async () => {
				if (backend === undefined) delete process.env.SWARM_LANG_BACKEND;
				else process.env.SWARM_LANG_BACKEND = backend;
				try {
					const raw = await test_runner.execute(
						{ scope, targets: ['adds numbers'] },
						{ directory: projDir },
					);
					const parsed = JSON.parse(raw as string);

					expect(parsed.success).toBe(false);
					expect(parsed.outcome).toBe('error');
					// The guard fires before framework detection.
					expect(parsed.framework).toBe('none');
					// Accurate: names targets' actual (filter-only) role.
					expect(parsed.error).toMatch(/targets/i);
					// Never the misleading files-centric text.
					expect(parsed.error).not.toContain('Provided files contain');
					expect(spawnCount).toBe(0);
				} finally {
					if (backend !== undefined) delete process.env.SWARM_LANG_BACKEND;
				}
			});
		}
	}

	test('files-with-targets still passes the guard and reaches the runner', async () => {
		fs.mkdirSync(path.join(projDir, 'src'), { recursive: true });
		fs.writeFileSync(path.join(projDir, 'src', 'foo.ts'), 'export {};\n');

		const raw = await test_runner.execute(
			{ scope: 'convention', files: ['src/foo.ts'], targets: ['x'] },
			{ directory: projDir },
		);
		const parsed = JSON.parse(raw as string);

		expect(parsed.outcome).not.toBe('error');
		expect(parsed.error).toBeUndefined();
		expect(spawnCount).toBeGreaterThan(0);
	});

	test('files-provided-but-unrecognized errors are retained', async () => {
		const raw = await test_runner.execute(
			{ scope: 'convention', files: ['notes.txt'] },
			{ directory: projDir },
		);
		const parsed = JSON.parse(raw as string);

		expect(parsed.success).toBe(false);
		expect(parsed.outcome).toBe('error');
		expect(parsed.error).toBe(
			'Provided files contain no recognized source files or direct test files',
		);
		expect(spawnCount).toBe(0);
	});
});
