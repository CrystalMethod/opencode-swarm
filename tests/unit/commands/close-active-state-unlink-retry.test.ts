import { afterEach, describe, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { _internals } from '../../../src/commands/close.js';
import { closeProjectDb, getProjectDb } from '../../../src/db/project-db.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const realUnlink = _internals.unlink;
const realSleep = _internals.sleep;
const realCollectGarbageBestEffort = _internals.collectGarbageBestEffort;

afterEach(() => {
	_internals.unlink = realUnlink;
	_internals.sleep = realSleep;
	_internals.collectGarbageBestEffort = realCollectGarbageBestEffort;
});

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

describe('active-state unlink retry', () => {
	test.each([
		'EBUSY',
		'EPERM',
	])('retries transient Windows %s locks', async (code) => {
		const unlink = mock(async () => {
			if (unlink.mock.calls.length < 3) throw errno(code);
		});
		const sleep = mock(async () => {});
		const collectGarbage = mock(() => {});
		_internals.unlink = unlink;
		_internals.sleep = sleep;
		_internals.collectGarbageBestEffort = collectGarbage;

		await _internals.unlinkActiveStateFileWithRetry('swarm.db');

		expect(unlink).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
		// #3248: GC now runs on EVERY failed attempt (a hedge for
		// GC-reclaimable Bun sqlite statement handles), not just the first.
		expect(collectGarbage).toHaveBeenCalledTimes(2);
		expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([25, 50]);
	});

	test('does not retry non-transient failures', async () => {
		const failure = errno('EACCES');
		const unlink = mock(async () => {
			throw failure;
		});
		const sleep = mock(async () => {});
		_internals.unlink = unlink;
		_internals.sleep = sleep;

		await expect(
			_internals.unlinkActiveStateFileWithRetry('swarm.db'),
		).rejects.toBe(failure);
		expect(unlink).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	test('stops after the bounded transient retry budget', async () => {
		const failure = errno('EBUSY');
		const unlink = mock(async () => {
			throw failure;
		});
		const sleep = mock(async () => {});
		_internals.unlink = unlink;
		_internals.sleep = sleep;

		await expect(
			_internals.unlinkActiveStateFileWithRetry('swarm.db'),
		).rejects.toBe(failure);
		// #3248: the production budget grew from [25,50,100,200] (~375 ms) to
		// ~15.2 s. Local instrumented Windows runs of case 4 below show the
		// Bun sqlite handle release is bimodal — instant (~5 ms) or ~11 s —
		// and on the long tail the old budget threw EBUSY from
		// unlinkActiveStateFileWithRetry itself (~3/10 runs). (The merge-group
		// hard failure in run 38507292215 evidenced the TEARDOWN helper's
		// budget; see tests/helpers/safe-test-dir.ts.)
		expect(unlink).toHaveBeenCalledTimes(21);
		expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([
			25, 50, 100, 200, 400, 600, 800, 1000, 1000, 1000, 1000, 1000, 1000, 1000,
			1000, 1000, 1000, 1000, 1000, 1000,
		]);
	});

	test('releases Bun query-cache handles before deleting a closed project database', async () => {
		const directory = canonicalMkdtemp('close-query-cache-');
		const databasePath = path.join(directory, '.swarm', 'swarm.db');
		try {
			const db = getProjectDb(directory);
			for (let index = 0; index < 100; index += 1) {
				db.query(`SELECT ${index} AS value`).get();
			}
			closeProjectDb(directory);

			await _internals.unlinkActiveStateFileWithRetry(databasePath);

			expect(existsSync(databasePath)).toBe(false);
		} finally {
			closeProjectDb(directory);
			safeRmRecursive(directory);
		}
		// #3248: the production retry budget spans ~15.2 s (the handle
		// release tail measured ~11 s), so the case needs an explicit
		// per-test budget above bun's 5 s default (CI already passes
		// --timeout 120000; local runs do not).
	}, 30000);
});
