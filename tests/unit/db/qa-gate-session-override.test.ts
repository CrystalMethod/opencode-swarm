/**
 * Service tests for the durable session QA-gate override store (#2668).
 *
 * The `qa_gate_session_override` table is the restart authority for a
 * session's ratchet-tighter QA policy: written durable-first by the
 * `/swarm qa-gates override` command, restored by `rehydrateState`, deleted
 * in lockstep with the session. These tests pin the service contract:
 * ratchet-only merge, fail-closed malformed-row reads, clear idempotency,
 * the empty-overrides invariant (no `true` gates => no row), and read-only
 * behavior when the project DB does not exist.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getProjectDb } from '../../../src/db/project-db.js';
import {
	clearAllSessionOverrides,
	clearOverrideForSession,
	getOverrideForSession,
	setOverrideForSession,
} from '../../../src/db/qa-gate-session-override.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let tempDir: string;

beforeEach(() => {
	tempDir = canonicalMkdtemp('qa-gate-session-override-test-');
});

afterEach(() => {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe('getOverrideForSession', () => {
	test('returns {} without creating the DB when none exists', () => {
		expect(getOverrideForSession(tempDir, 'sess-a')).toEqual({});
		expect(fs.existsSync(path.join(tempDir, '.swarm', 'swarm.db'))).toBe(false);
	});

	test('round-trips a ratchet-tighter override', () => {
		setOverrideForSession(tempDir, 'sess-a', { mutation_test: true });
		expect(getOverrideForSession(tempDir, 'sess-a')).toEqual({
			mutation_test: true,
		});
	});

	test('malformed row fails closed to {} (never throws, never widens)', () => {
		setOverrideForSession(tempDir, 'sess-bad', { sast_enabled: true });
		const db = getProjectDb(tempDir);
		db.run(
			'UPDATE qa_gate_session_override SET gates = ? WHERE session_id = ?',
			['{not json', 'sess-bad'],
		);
		expect(getOverrideForSession(tempDir, 'sess-bad')).toEqual({});
	});
});

describe('setOverrideForSession', () => {
	test('ratchet-only: true wins, false never disables', () => {
		setOverrideForSession(tempDir, 'sess-a', { mutation_test: true });
		const merged = setOverrideForSession(tempDir, 'sess-a', {
			mutation_test: false,
			hallucination_guard: true,
		});
		expect(merged).toEqual({ mutation_test: true, hallucination_guard: true });
		expect(getOverrideForSession(tempDir, 'sess-a')).toEqual({
			mutation_test: true,
			hallucination_guard: true,
		});
	});

	test('non-boolean and unknown gate keys are ignored', () => {
		const merged = setOverrideForSession(tempDir, 'sess-a', {
			mutation_test: true,
			// @ts-expect-error deliberate malformed input
			council_general_review: true,
			// @ts-expect-error deliberate malformed input
			reviewer: 'yes',
		});
		expect(merged).toEqual({ mutation_test: true });
	});

	test('empty-overrides invariant: a merge with no true gates keeps no row', () => {
		// Fresh session, no stored true, incoming patch carries no true gate:
		// the merged map is empty, so there is no row (never an upsert of {}).
		const merged = setOverrideForSession(tempDir, 'sess-fresh', {
			mutation_test: false,
		});
		expect(merged).toEqual({});
		expect(getOverrideForSession(tempDir, 'sess-fresh')).toEqual({});
		// A stored true is never removable through the ratchet (that is the
		// point of ratchet-only policy); removal happens only via clear/
		// session end, which delete the row outright.
		setOverrideForSession(tempDir, 'sess-held', { mutation_test: true });
		const stillHeld = setOverrideForSession(tempDir, 'sess-held', {
			mutation_test: false,
		});
		expect(stillHeld).toEqual({ mutation_test: true });
	});

	test('requires a session id', () => {
		expect(() => setOverrideForSession(tempDir, '', {})).toThrow();
	});
});

describe('clearOverrideForSession', () => {
	test('deletes an existing row and reports true', () => {
		setOverrideForSession(tempDir, 'sess-a', { mutation_test: true });
		expect(clearOverrideForSession(tempDir, 'sess-a')).toBe(true);
		expect(getOverrideForSession(tempDir, 'sess-a')).toEqual({});
	});

	test('idempotent: clearing an absent row is a no-op returning false', () => {
		expect(clearOverrideForSession(tempDir, 'never-existed')).toBe(false);
		setOverrideForSession(tempDir, 'sess-a', { mutation_test: true });
		clearOverrideForSession(tempDir, 'sess-a');
		expect(clearOverrideForSession(tempDir, 'sess-a')).toBe(false);
	});

	test('no-op when the project DB does not exist', () => {
		expect(clearOverrideForSession(tempDir, 'sess-a')).toBe(false);
	});
});

describe('clearAllSessionOverrides', () => {
	test('sweeps every row and reports the count', () => {
		setOverrideForSession(tempDir, 'sess-a', { mutation_test: true });
		setOverrideForSession(tempDir, 'sess-b', { sast_enabled: true });
		expect(clearAllSessionOverrides(tempDir)).toBe(2);
		expect(clearAllSessionOverrides(tempDir)).toBe(0);
		expect(getOverrideForSession(tempDir, 'sess-a')).toEqual({});
	});

	test('no-op when the project DB does not exist', () => {
		expect(clearAllSessionOverrides(tempDir)).toBe(0);
	});
});
