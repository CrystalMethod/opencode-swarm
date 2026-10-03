/**
 * FB-T2: the `_files` default (args.files || []) fix in the convention, graph
 * and impact branches is framework-independent. Before the fix, a targets-only
 * call (files omitted) dereferenced `args.files!` and threw
 * "Cannot read properties of undefined (reading 'filter')" once a framework
 * was detected. The Maven variant lives in test-runner-maven-nested.test.ts;
 * this pins the same guard for a non-Maven (Bun) project on both backends.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals, test_runner } from '../../../src/tools/test-runner';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realBunSpawn = _internals.bunSpawn;
const realIsCommandAvailable = _internals.isCommandAvailable;

let spawnCount = 0;
let tempDir: string;
let priorBackend: string | undefined;

beforeEach(() => {
	tempDir = canonicalMkdtemp('test-runner-omitted-files-');
	fs.writeFileSync(
		path.join(tempDir, 'package.json'),
		JSON.stringify({ name: 'fixture', scripts: { test: 'bun test' } }),
	);
	spawnCount = 0;
	_internals.bunSpawn = ((..._args: unknown[]) => {
		spawnCount++;
		throw new Error('spawn must not be reached');
	}) as unknown as typeof _internals.bunSpawn;
	_internals.isCommandAvailable = () => true;
	priorBackend = process.env.SWARM_LANG_BACKEND;
});

afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
	_internals.isCommandAvailable = realIsCommandAvailable;
	if (priorBackend === undefined) delete process.env.SWARM_LANG_BACKEND;
	else process.env.SWARM_LANG_BACKEND = priorBackend;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const cases = [
	{
		scope: 'convention' as const,
		error:
			'Provided files contain no recognized source files or direct test files',
	},
	{
		scope: 'graph' as const,
		error: 'Provided files contain no source files with recognized extensions',
	},
	{
		scope: 'impact' as const,
		error: 'Provided files contain no source files with recognized extensions',
	},
];

describe('targets without files on a Bun project', () => {
	for (const { scope, error } of cases) {
		test(`scope=${scope}: structured error, no TypeError, no spawn`, async () => {
			for (const backend of [undefined, 'legacy']) {
				if (backend === undefined) delete process.env.SWARM_LANG_BACKEND;
				else process.env.SWARM_LANG_BACKEND = backend;

				const raw = await test_runner.execute(
					{ scope, targets: ['adds numbers'] },
					{ directory: tempDir },
				);
				const parsed = JSON.parse(raw);

				expect(parsed.success).toBe(false);
				expect(parsed.framework).toBe('bun');
				expect(parsed.error).toBe(error);
				expect(raw).not.toContain('Cannot read properties of undefined');
			}
			expect(spawnCount).toBe(0);
		});
	}
});
