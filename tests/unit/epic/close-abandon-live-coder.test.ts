/**
 * `/swarm epic close --abandon` must not tear the Epic down while a coder is
 * still owned by a live dispatch.
 *
 * Abandon steps off the epic branch and deletes the lifecycle sentinel. A coder
 * that settles afterwards finds no Epic context (`epicCommitLandingFor` returns
 * undefined) and takes the ordinary merge-back path onto the original branch —
 * landing work the user explicitly abandoned. This is the close-side twin of
 * the start-side guard in `src/epic/start.ts`.
 *
 * The settlement scan is driven through the same `_internals` seam
 * `start-inflight.test.ts` uses, so the test does not depend on the WAL
 * record's on-disk schema.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	closeEpic,
	_internals as closeInternals,
} from '../../../src/epic/close';
import { epicSentinelExists } from '../../../src/epic/lifecycle';
import { openEpicForTest } from '../../helpers/epic-lifecycle';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import { createStartProject } from './start-fixture';

let dir: string;
let restoreClock: Restore | null = null;
let realList: typeof closeInternals.listCoderSettlementWalStates;

beforeEach(async () => {
	restoreClock = freezeClock({ isoNow: '2026-05-01T08:00:00.000Z' });
	dir = await createStartProject('epic-close-live-', { git: false });
	openEpicForTest(dir);
	realList = closeInternals.listCoderSettlementWalStates;
});

afterEach(() => {
	closeInternals.listCoderSettlementWalStates = realList;
	restoreClock?.();
	restoreClock = null;
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

function stubWal(
	states: Array<{ taskId: string; state: string }>,
	truncated = false,
): void {
	closeInternals.listCoderSettlementWalStates = (async () => ({
		states: states.map((s) => ({
			taskId: s.taskId,
			state: s.state,
			ownedInProcess: false,
			ownedByLiveForeignPid: true,
		})),
		truncated,
	})) as never;
}

describe('closeEpic --abandon refuses while a coder is live', () => {
	test('a live coder settlement blocks the abandon and keeps the sentinel', async () => {
		stubWal([{ taskId: '1.1', state: 'DISPATCHED' }]);

		const result = await closeEpic({ directory: dir, abandon: true });

		expect(result).toMatchObject({ status: 'refused', reason: 'coders-live' });
		if (result.status === 'refused') {
			expect(result.details[0]).toContain('1.1');
		}
		// The teardown that would strand the coder must not have run.
		expect(epicSentinelExists(dir)).toBe(true);
	});

	test('a live coder blocks even when its state is PREPARED', async () => {
		stubWal([{ taskId: '1.1', state: 'PREPARED' }]);

		expect(await closeEpic({ directory: dir, abandon: true })).toMatchObject({
			status: 'refused',
			reason: 'coders-live',
		});
	});

	test('the guard is abandon-only: a normal close is unaffected', async () => {
		stubWal([{ taskId: '1.1', state: 'DISPATCHED' }]);

		// A non-abandon close refuses on the plan tasks first, exactly as before.
		const result = await closeEpic({ directory: dir, abandon: false });
		expect(result).toMatchObject({ status: 'refused' });
		if (result.status === 'refused') {
			expect(result.reason).not.toBe('coders-live');
		}
	});

	test('a terminal settlement does not block the abandon', async () => {
		stubWal([{ taskId: '1.1', state: 'COMMITTED' }]);

		expect(await closeEpic({ directory: dir, abandon: true })).toMatchObject({
			status: 'closed',
		});
	});

	test('an unreadable WAL is not treated as a live coder', async () => {
		// `unreadable` means the state cannot be proven in flight. The start-side
		// guard blocks on it with a recovery remedy; the close guard must not
		// invent a live coder from a corrupt record.
		stubWal([{ taskId: '1.1', state: 'unreadable' }]);

		expect(await closeEpic({ directory: dir, abandon: true })).toMatchObject({
			status: 'closed',
		});
	});
});
