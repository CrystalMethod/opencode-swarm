/**
 * `/swarm epic` recovery from the fail-closed "state unreadable" marker.
 *
 * The marker in `src/turbo/epic/state.ts` is process-local and is only lifted
 * by a successful re-validation (`repairStateUnreadable`) or a row teardown.
 * Before this wiring, nothing on the command path called the repair, so once a
 * corrupt `.swarm/epic-state.json` had been seen, `/swarm epic status` kept
 * reporting "unreadable" for the rest of the process even after the user fixed
 * or removed the file. Real state module + real temp project; no mocks.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleEpicCommand } from '../../../src/commands/epic';
import { resetSwarmState } from '../../../src/state';
import {
	isStateUnreadable,
	loadEpicSessionState,
} from '../../../src/turbo/epic/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const SESSION = 'sess-epic-recovery';

let dir: string;
let cleanup: () => void;

function stateFile(): string {
	return path.join(dir, '.swarm', 'epic-state.json');
}

/** Write a corrupt legacy state file and let the real loader flag it. */
function corruptAndFlag(): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(stateFile(), '{ this is not json');
	expect(loadEpicSessionState(dir, SESSION)).toBeNull();
	expect(isStateUnreadable(dir)).toBe(true);
}

beforeEach(() => {
	resetSwarmState();
	({ dir, cleanup } = createSafeTestDir('epic-state-recovery-'));
});

afterEach(() => {
	resetSwarmState();
	cleanup();
});

describe('/swarm epic — unreadable-state recovery', () => {
	test('status stays unreadable (with remediation) while the file is still corrupt', async () => {
		corruptAndFlag();
		const out = await handleEpicCommand(dir, ['status'], SESSION);
		expect(out).toContain('Epic Mode state is unreadable');
		expect(out).toContain('Fix or remove `.swarm/epic-state.json`');
		expect(out).toContain('/swarm reset-session');
		expect(isStateUnreadable(dir)).toBe(true);
	});

	test('removing the corrupt file lets the next status recover without a restart', async () => {
		corruptAndFlag();
		const before = await handleEpicCommand(dir, ['status'], SESSION);
		expect(before).toContain('Epic Mode state is unreadable');

		fs.rmSync(stateFile());
		const after = await handleEpicCommand(dir, ['status'], SESSION);
		expect(after).not.toContain('unreadable');
		expect(after).toContain('has not been toggled');
		expect(isStateUnreadable(dir)).toBe(false);
	});

	test('repairing the file contents also recovers (bare `/swarm epic` = status)', async () => {
		corruptAndFlag();
		// Fixed stamp: the legacy file's top-level `updatedAt` is metadata only
		// (no session rows → nothing is freshness-checked).
		fs.writeFileSync(
			stateFile(),
			`${JSON.stringify({ version: 1, updatedAt: '2026-01-01T00:00:00.000Z', sessions: {} })}\n`,
		);
		const out = await handleEpicCommand(dir, [], SESSION);
		expect(out).toContain('Epic Mode — Status');
		expect(out).not.toContain('unreadable');
		expect(isStateUnreadable(dir)).toBe(false);
	});
});
