/**
 * Issue #2705 regression tests — every `pkg-audit.ts` runner spawn must pass
 * `stdin: 'ignore'` to `bunSpawn`.
 *
 * RED at base 374c2642e: none of the eight runner sites passes `stdin`, so
 * `mapStdio(undefined)` resolves stdin to `'pipe'` and every audit child
 * receives a never-closed stdin pipe (the v7.3.3 class).
 *
 * Structure follows tests/unit/tools/pkg-audit-cwd.test.ts (spyOn(Bun,
 * 'spawn') capture + discovery `_internals.spawnSyncImpl` seam).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	clearToolchainCache,
	_internals as discoveryInternals,
} from '../../../src/build/discovery.js';
import { pkg_audit } from '../../../src/tools/pkg-audit.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalDiscoverySpawnSync = discoveryInternals.spawnSyncImpl;

interface CapturedSpawn {
	cmd: string[];
	opts: Record<string, unknown>;
}

let spawnCalls: CapturedSpawn[] = [];
let tempDir: string;
let bunSpawnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	spawnCalls = [];
	clearToolchainCache();
	discoveryInternals.spawnSyncImpl = () => ({
		stdout: new Uint8Array(),
		stderr: new Uint8Array(),
		exitCode: 0,
		success: true,
	});
	tempDir = canonicalMkdtemp('pkg-audit-stdin-2705-');
	bunSpawnSpy = spyOn(Bun, 'spawn').mockImplementation(
		(
			cmd: string[],
			opts: { cwd?: string; stdout?: string; stderr?: string },
		) => {
			spawnCalls.push({ cmd, opts: opts as Record<string, unknown> });
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
				kill() {},
			} as unknown as ReturnType<typeof Bun.spawn>;
		},
	);
});

afterEach(() => {
	discoveryInternals.spawnSyncImpl = originalDiscoverySpawnSync;
	clearToolchainCache();
	bunSpawnSpy.mockRestore();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const ECOSYSTEMS = [
	'npm',
	'pip',
	'cargo',
	'go',
	'dotnet',
	'ruby',
	'dart',
	'composer',
] as const;

describe('pkg-audit runner spawns pass stdin ignore (#2705)', () => {
	for (const eco of ECOSYSTEMS) {
		it(`${eco} audit spawn passes stdin ignore`, async () => {
			const before = spawnCalls.length;
			await pkg_audit.execute({ ecosystem: eco }, {
				directory: tempDir,
			} as any);
			const mine = spawnCalls.slice(before);

			expect(
				mine.length,
				`pkg-audit spawn for ${eco} never reached Bun.spawn (runner skipped — stdin contract unproven)`,
			).toBeGreaterThanOrEqual(1);

			for (const call of mine) {
				expect(
					call.opts.stdin,
					`pkg-audit spawn for ${eco} missing stdin ignore (cmd: ${call.cmd.join(' ')})`,
				).toBe('ignore');
			}
		}, 20_000);
	}
});
