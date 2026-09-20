import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import {
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';
import { createPublicationFixture } from './pr-workflow-publication.test-fixtures.js';

/**
 * Issue #2866: the shared PR-workflow fixture teardowns removed their temp
 * project directories with an unguarded zero-retry `fs.rm`, so a Windows
 * directory-handle holder (just-closed SQLite handle lag, AV scan, indexer)
 * made the removal throw EBUSY/EPERM/ENOTEMPTY out of `afterEach`, failing a
 * test whose own assertions had already passed. The teardowns now route
 * through `safeRmRecursive` (containment proof + per-directory project-db
 * handle release + bounded EBUSY/EPERM/ENOTEMPTY retry); these tests pin both
 * directions of that contract.
 *
 * The holder is a self-terminating `ping -n K` child whose working directory
 * is the fixture dir: Windows refuses the recursive removal with EBUSY while
 * a process cwd is inside it, which is the faithful deterministic surrogate
 * for the natural race (a held child FILE or an fs.opendir handle does not
 * discriminate — Bun's fs.rm internally retries both past 1.8 s). No kill()
 * is involved: Bun's kill() only emulates the child exit event while the OS
 * process — and its cwd handle — can linger for another second or more.
 * Measured lifetimes: -n 2 ≈ 1.02 s (inside safeRmRecursive's ~2.1 s window),
 * -n 4 ≈ 3.04 s (outlives it).
 */
const isWindows = process.platform === 'win32';
const TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

/** Spawns the holder; resolves when the child exits on its own. */
function holdDirectoryUntilExit(dir: string, pings: number): Promise<void> {
	const child = spawn('ping', ['-n', String(pings), '127.0.0.1'], {
		cwd: dir,
		stdio: 'ignore',
		// Backstop only (invariant 3): holders self-terminate in ~1 s (-n 2)
		// or ~3 s (-n 4); this bounds a pathological never-exiting child.
		timeout: 10_000,
	});
	if (child.pid === undefined) {
		throw new Error('directory holder child failed to spawn');
	}
	return new Promise<void>((resolve) => {
		child.on('exit', () => resolve());
	});
}

/** Bun materializes spawned children on a later event-loop turn. */
function flushEventLoop(ms = 100): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('pr-workflow fixture teardown EBUSY tolerance (issue 2866)', () => {
	test.skipIf(!isWindows)(
		'gate fixture teardown rides out a transient directory holder',
		async () => {
			setupPrWorkflowGateFixtures();
			const dir = tempDir;
			const holderDone = holdDirectoryUntilExit(dir, 2);
			await flushEventLoop();
			await teardownPrWorkflowGateFixtures();
			await holderDone;
			expect(existsSync(dir)).toBe(false);
		},
	);

	test.skipIf(!isWindows)(
		'publication fixture teardown rides out a transient directory holder',
		async () => {
			const fixture = await createPublicationFixture();
			const holderDone = holdDirectoryUntilExit(fixture.directory, 2);
			await flushEventLoop();
			await fixture.teardown();
			await holderDone;
			expect(existsSync(fixture.directory)).toBe(false);
		},
	);

	test('plain teardown still removes both fixture temp directories', async () => {
		setupPrWorkflowGateFixtures();
		const gateDir = tempDir;
		await teardownPrWorkflowGateFixtures();
		expect(existsSync(gateDir)).toBe(false);

		const fixture = await createPublicationFixture();
		const publicationDir = fixture.directory;
		await fixture.teardown();
		expect(existsSync(publicationDir)).toBe(false);
	});

	test.skipIf(!isWindows)(
		'teardown still throws transiently when a holder outlives the bounded window',
		async () => {
			setupPrWorkflowGateFixtures();
			const dir = tempDir;
			const holderDone = holdDirectoryUntilExit(dir, 4);
			await flushEventLoop();
			let caught: unknown;
			try {
				try {
					await teardownPrWorkflowGateFixtures();
				} catch (error) {
					caught = error;
				}
				expect(caught).toBeInstanceOf(Error);
				const code = (caught as NodeJS.ErrnoException | undefined)?.code;
				expect(TRANSIENT_CODES.has(code ?? '')).toBe(true);
			} finally {
				// Assert-failure safety: never leak the holder child or the dir.
				await holderDone;
				try {
					safeRmRecursive(dir);
				} catch {
					// best-effort cleanup of the leaked fixture dir
				}
			}
		},
	);
});
