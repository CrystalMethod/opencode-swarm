/**
 * `/swarm reset-session` clears durable Epic Mode session rows (F-Liveness).
 * File: tests/unit/commands/reset-session-epic-rows.test.ts
 *
 * reset-session discards every in-memory agent session (and their snapshot
 * rows). Previously the durable Epic rows survived, so the project-scoped
 * Epic probe kept answering "active" for sessions the reset had discarded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	handleResetSessionCommand,
	_internals as resetInternals,
} from '../../../src/commands/reset-session';
import { listCoordinationStates } from '../../../src/db/coordination-store';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { enableEpicMode } from '../../../src/turbo/epic/state';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const NAMESPACE = 'turbo.epic.session';
const originalClear = resetInternals.clearAllEpicSessionRows;
const originalConfigGate = resetInternals.isEpicModeConfigEnabledForDirectory;

function writeEpicConfig(): void {
	mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			turbo: { strategy: 'standard', epic: { mode: { enabled: true } } },
		}),
	);
}
let dir: string;

beforeEach(() => {
	resetSwarmState();
	dir = canonicalMkdtemp('reset-epic-rows-');
	mkdirSync(path.join(dir, '.swarm', 'session'), { recursive: true });
});

afterEach(() => {
	resetInternals.clearAllEpicSessionRows = originalClear;
	resetInternals.isEpicModeConfigEnabledForDirectory = originalConfigGate;
	resetSwarmState();
	closeAllProjectDbs();
	safeRmRecursive(dir);
});

describe('handleResetSessionCommand — Epic Mode rows', () => {
	it('regression: sweeps every session’s durable Epic row', async () => {
		writeEpicConfig();
		enableEpicMode(dir, 'ses_invoker');
		enableEpicMode(dir, 'ses_other');
		expect(listCoordinationStates(dir, NAMESPACE)).toHaveLength(2);

		const output = await handleResetSessionCommand(dir, [], 'ses_invoker');

		expect(output).toContain('Cleared 2 durable Epic Mode session row(s)');
		expect(listCoordinationStates(dir, NAMESPACE)).toHaveLength(0);
	}, 60_000);

	it('a sweep failure is reported and the reset continues', async () => {
		writeEpicConfig();
		resetInternals.clearAllEpicSessionRows = () => {
			throw new Error('db locked');
		};
		const output = await handleResetSessionCommand(dir, [], 'ses_invoker');
		expect(output).toContain(
			'Durable Epic Mode session row sweep failed: db locked',
		);
		expect(output).toContain('in-memory agent session(s)');
	}, 60_000);

	it('sweeps when only the in-memory Epic flag is set (config off)', async () => {
		enableEpicMode(dir, 'ses_invoker');
		ensureAgentSession('ses_invoker', 'architect').epicModeActive = true;
		const output = await handleResetSessionCommand(dir, [], 'ses_invoker');
		expect(output).toContain('Cleared 1 durable Epic Mode session row(s)');
	}, 60_000);

	it('non-Epic (config off, no flag): no sweep, no DB read, no Epic output line', async () => {
		let sweeps = 0;
		resetInternals.clearAllEpicSessionRows = () => {
			sweeps++;
			throw new Error('must not sweep for a non-Epic project');
		};
		const output = await handleResetSessionCommand(dir, [], 'ses_invoker');
		expect(sweeps).toBe(0);
		expect(output).not.toContain('Epic Mode');
		expect(output).toContain('in-memory agent session(s)');
	}, 60_000);
});
