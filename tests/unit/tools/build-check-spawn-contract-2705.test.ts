/**
 * Issue #2705 regression tests — build-check `executeCommand` bounded-spawn
 * contract (AGENTS.md invariant 3).
 *
 * RED at base 374c2642e: the spawn options carried no `stdin: 'ignore'`
 * (mapStdio(undefined) → 'pipe', the never-closed stdin-pipe class), no
 * explicit `maxBuffer`, no best-effort kill after output settle, and no
 * `_internals.bunSpawn` seam to observe the call-site options.
 *
 * Structure follows tests/unit/tools/pkg-audit-cwd.test.ts (spyOn(Bun,
 * 'spawn') capture + discovery `_internals.spawnSyncImpl` seam) and the
 * frozen acceptance checks C1/C2 for this issue.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	clearToolchainCache,
	_internals as discoveryInternals,
} from '../../../src/build/discovery.js';
import { _internals, runBuildCheck } from '../../../src/tools/build-check.js';
import { DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES } from '../../../src/utils/bun-compat.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalDiscoverySpawnSync = discoveryInternals.spawnSyncImpl;
const originalBunSpawnSeam = _internals.bunSpawn;

interface CapturedSpawn {
	cmd: string[];
	opts: Record<string, unknown>;
	killCount: number;
}

let captured: CapturedSpawn[] = [];
let tempDir: string;
let bunSpawnSpy: ReturnType<typeof spyOn>;
const realPlatform = process.platform;

function mockChild(entry: CapturedSpawn) {
	const stream = () =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
	return {
		stdout: stream(),
		stderr: stream(),
		exited: Promise.resolve(0),
		exitCode: 0,
		signalCode: null,
		pid: 12345,
		kill() {
			entry.killCount++;
		},
	} as unknown as ReturnType<typeof Bun.spawn>;
}

beforeEach(() => {
	captured = [];
	clearToolchainCache();
	discoveryInternals.spawnSyncImpl = () => ({
		stdout: new Uint8Array(),
		stderr: new Uint8Array(),
		exitCode: 0,
		success: true,
	});
	tempDir = canonicalMkdtemp('build-check-spawn-2705-');
	fs.writeFileSync(
		path.join(tempDir, 'package.json'),
		JSON.stringify({ name: 'bc2705', scripts: { build: 'echo ok' } }),
	);
	bunSpawnSpy = spyOn(Bun, 'spawn').mockImplementation(
		(cmd: string[], opts: Record<string, unknown>) => {
			const entry: CapturedSpawn = { cmd, opts, killCount: 0 };
			captured.push(entry);
			return mockChild(entry);
		},
	);
});

afterEach(() => {
	bunSpawnSpy.mockRestore();
	discoveryInternals.spawnSyncImpl = originalDiscoverySpawnSync;
	clearToolchainCache();
	_internals.bunSpawn = originalBunSpawnSeam;
	Object.defineProperty(process, 'platform', {
		value: realPlatform,
		configurable: true,
	});
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('build-check executeCommand spawn contract (#2705)', () => {
	it('build command spawn forwards stdin ignore and the 300000ms timeout', async () => {
		await runBuildCheck(tempDir, { scope: 'all', mode: 'build' });

		const buildCalls = captured.filter((c) =>
			c.cmd.join(' ').includes('build'),
		);
		expect(
			buildCalls.length,
			'executeCommand spawn for the build command never reached Bun.spawn',
		).toBeGreaterThanOrEqual(1);

		expect(
			buildCalls[0].opts.stdin,
			'executeCommand spawn options missing stdin ignore (never-closed stdin pipe — v7.3.3 class)',
		).toBe('ignore');
		expect(
			buildCalls[0].opts.timeout,
			'executeCommand spawn options missing bounded timeout 300000',
		).toBe(300000);
	});

	it('kills the child after the output settles even on success', async () => {
		await runBuildCheck(tempDir, { scope: 'all', mode: 'build' });

		const kills = captured.reduce((sum, c) => sum + c.killCount, 0);
		expect(
			kills,
			'executeCommand never calls proc.kill() after the output settle (best-effort kill missing)',
		).toBeGreaterThanOrEqual(1);
	});

	it('expresses the explicit 5 MiB maxBuffer bound at the bunSpawn call site', async () => {
		const siteOpts: Array<Record<string, unknown>> = [];
		_internals.bunSpawn = ((cmd: string[], opts?: Record<string, unknown>) => {
			siteOpts.push({ cmd: [...cmd], ...(opts ?? {}) });
			return mockChild({ cmd, opts: opts ?? {}, killCount: 0 });
		}) as unknown as typeof _internals.bunSpawn;

		await runBuildCheck(tempDir, { scope: 'all', mode: 'build' });

		const buildOpts = siteOpts.filter((o) =>
			(o.cmd as string[]).join(' ').includes('build'),
		);
		expect(
			buildOpts.length,
			'executeCommand spawn never routed through the _internals.bunSpawn seam',
		).toBeGreaterThanOrEqual(1);

		expect(
			buildOpts[0].maxBuffer,
			'executeCommand bunSpawn options missing explicit maxBuffer bound',
		).toBe(DEFAULT_BUN_SPAWN_MAX_BUFFER_BYTES);
		expect(buildOpts[0].stdin).toBe('ignore');
	});

	it('keeps the full option set on the POSIX /bin/sh -c arm', async () => {
		Object.defineProperty(process, 'platform', {
			value: 'linux',
			configurable: true,
		});

		await runBuildCheck(tempDir, { scope: 'all', mode: 'build' });

		const buildCalls = captured.filter((c) =>
			c.cmd.join(' ').includes('build'),
		);
		expect(buildCalls.length).toBeGreaterThanOrEqual(1);
		expect(buildCalls[0].cmd[0]).toBe('/bin/sh');
		expect(buildCalls[0].cmd[1]).toBe('-c');
		expect(
			buildCalls[0].opts.stdin,
			'POSIX /bin/sh -c arm missing stdin ignore',
		).toBe('ignore');
		expect(buildCalls[0].opts.timeout).toBe(300000);
	});
});
