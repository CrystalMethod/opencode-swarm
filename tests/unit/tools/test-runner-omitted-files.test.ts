/**
 * Targets-only calls (files omitted) in the convention/graph/impact scopes
 * are rejected UP FRONT by the hard guard (#3041): one unified, accurate
 * error naming targets' filter-only role, framework 'none' (the guard fires
 * before detection), no spawn, no TypeError. The Maven variant lives in
 * test-runner-maven-nested.test.ts; this pins a non-Maven (Bun) project on
 * both backends.
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
			'scope "convention", "graph", and "impact" require a non-empty files array - targets only filter which tests run and cannot substitute for files (omitting files causes unsafe full-project discovery)',
	},
	{
		scope: 'graph' as const,
		error:
			'scope "convention", "graph", and "impact" require a non-empty files array - targets only filter which tests run and cannot substitute for files (omitting files causes unsafe full-project discovery)',
	},
	{
		scope: 'impact' as const,
		error:
			'scope "convention", "graph", and "impact" require a non-empty files array - targets only filter which tests run and cannot substitute for files (omitting files causes unsafe full-project discovery)',
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
				expect(parsed.framework).toBe('none');
				expect(parsed.error).toBe(error);
				expect(raw).not.toContain('Cannot read properties of undefined');
			}
			expect(spawnCount).toBe(0);
		});
	}
});
