/**
 * Issue #2829 — durable Stage B dispatch-generation binding store unit tests
 * (frozen acceptance check C1). Pins: dispatch-time atomic write round-trip,
 * schema-version rejection, record-identity rejection, corrupt-JSON
 * fail-closed null, TTL staleness null, delete idempotence, per-task
 * heterogeneous lookup with malformed-entry fallthrough, path hashing (raw
 * sessionID never in the path), bounded prune, and temp-file non-targeting.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	deleteStageBDispatchBindings,
	isRecordableCallId,
	isRecordableSessionId,
	MAX_STAGE_B_BINDING_FILES_PER_SESSION_DIR,
	MAX_STAGE_B_BINDING_SESSION_DIRS,
	readStageBDispatchBindings,
	recordStageBDispatchBindings,
	STAGE_B_BINDING_TTL_MS,
	_internals as storeInternals,
} from '../../../src/background/stage-b-dispatch-binding-store';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir = '';
const SESSION = 'sess-2829-store';
const CALL = 'call-2829-1';

beforeEach(() => {
	dir = canonicalMkdtemp('stage-b-store-2829-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function recordPathFor(sessionID: string, callID: string): string {
	return storeInternals.recordPath(dir, sessionID, callID);
}

describe('stage-b-dispatch-binding-store (#2829)', () => {
	it('round-trips a recorded binding under the hashed sessionID path', () => {
		const ok = recordStageBDispatchBindings(dir, {
			sessionID: SESSION,
			callID: CALL,
			bindings: [
				{ taskId: '1.1', generation: 3 },
				{ taskId: '1.2', generation: 4 },
			],
		});
		expect(ok).toBe(true);
		const p = recordPathFor(SESSION, CALL);
		expect(fs.existsSync(p)).toBe(true);
		// Raw sessionID never appears as a path component (hashed convention).
		expect(p).not.toContain(SESSION);
		const read = readStageBDispatchBindings(dir, SESSION, CALL);
		expect(read?.sessionID).toBe(SESSION);
		expect(read?.callID).toBe(CALL);
		expect(read?.bindings).toEqual([
			{ taskId: '1.1', generation: 3 },
			{ taskId: '1.2', generation: 4 },
		]);
	});

	it('rejects a wrong schema version fail-closed (null)', () => {
		recordStageBDispatchBindings(dir, {
			sessionID: SESSION,
			callID: CALL,
			bindings: [{ taskId: '1.1', generation: 1 }],
		});
		const p = recordPathFor(SESSION, CALL);
		const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<
			string,
			unknown
		>;
		raw.schemaVersion = 99;
		fs.writeFileSync(p, JSON.stringify(raw));
		expect(readStageBDispatchBindings(dir, SESSION, CALL)).toBeNull();
	});

	it('rejects a record whose identity does not match the request (null)', () => {
		recordStageBDispatchBindings(dir, {
			sessionID: SESSION,
			callID: CALL,
			bindings: [{ taskId: '1.1', generation: 1 }],
		});
		// Cross-session collision must not validate: same callID, other session.
		expect(readStageBDispatchBindings(dir, 'sess-2829-other', CALL)).toBeNull();
		// Same session, other callID.
		expect(readStageBDispatchBindings(dir, SESSION, 'call-2829-2')).toBeNull();
	});

	it('treats corrupt/truncated JSON as null (a partial record never validates)', () => {
		const p = recordPathFor(SESSION, CALL);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, '{"schemaVersion":1,"sessionID":"sess-2829-st'); // truncated
		expect(readStageBDispatchBindings(dir, SESSION, CALL)).toBeNull();
	});

	it('treats a TTL-stale record as null', () => {
		recordStageBDispatchBindings(dir, {
			sessionID: SESSION,
			callID: CALL,
			bindings: [{ taskId: '1.1', generation: 1 }],
		});
		const stale = () => 4102444800000; // 2100-01-01T00:00:00Z — far past TTL of any record written now
		expect(
			readStageBDispatchBindings(dir, SESSION, CALL, { nowMs: stale }),
		).toBeNull();
		// Fresh clock still reads it.
		expect(readStageBDispatchBindings(dir, SESSION, CALL)).not.toBeNull();
	});
	it('per-taskId lookup is per-task; a tampered malformed entry fails the WHOLE record closed', () => {
		recordStageBDispatchBindings(dir, {
			sessionID: SESSION,
			callID: CALL,
			bindings: [
				{ taskId: '1.1', generation: 2 },
				{ taskId: '1.2', generation: 5 },
				{ taskId: '1.3', generation: 7 },
			],
		});
		const record = readStageBDispatchBindings(dir, SESSION, CALL);
		// Heterogeneous per-task outcomes from one file.
		expect(record?.bindings.find((b) => b.taskId === '1.1')?.generation).toBe(
			2,
		);
		expect(record?.bindings.find((b) => b.taskId === '1.2')?.generation).toBe(
			5,
		);
		expect(record?.bindings.find((b) => b.taskId === '9.9')).toBeUndefined();
		// Tampered per-task entry (injected on disk): the read-side shape
		// validation fails the whole record closed (round-2 review finding 2 —
		// the gate's reconstruction must never see a corrupt generation).
		const p = recordPathFor(SESSION, CALL);
		const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
			bindings: Array<{ taskId: string; generation: number }>;
		};
		raw.bindings.push({ taskId: '1.4', generation: -1 });
		fs.writeFileSync(p, JSON.stringify(raw));
		expect(readStageBDispatchBindings(dir, SESSION, CALL)).toBeNull();
		// Same for a non-integer generation.
		raw.bindings[raw.bindings.length - 1] = {
			taskId: '1.4',
			generation: 1.5,
		};
		fs.writeFileSync(p, JSON.stringify(raw));
		expect(readStageBDispatchBindings(dir, SESSION, CALL)).toBeNull();
	});

	it('deleteStageBDispatchBindings is idempotent and removes the record', () => {
		recordStageBDispatchBindings(dir, {
			sessionID: SESSION,
			callID: CALL,
			bindings: [{ taskId: '1.1', generation: 1 }],
		});
		deleteStageBDispatchBindings(dir, SESSION, CALL);
		expect(readStageBDispatchBindings(dir, SESSION, CALL)).toBeNull();
		expect(() =>
			deleteStageBDispatchBindings(dir, SESSION, CALL),
		).not.toThrow();
	});

	it('record filters malformed bindings and rejects pathological sessionIDs', () => {
		expect(
			recordStageBDispatchBindings(dir, {
				sessionID: SESSION,
				callID: CALL,
				bindings: [
					{ taskId: '', generation: 1 },
					{ taskId: '1.1', generation: Number.NaN },
					{ taskId: '1.2', generation: 1.5 },
					{ taskId: '1.3', generation: -2 },
				],
			}),
		).toBe(false);
		expect(isRecordableSessionId('')).toBe(false);
		expect(isRecordableSessionId(undefined)).toBe(false);
		expect(isRecordableSessionId('CON')).toBe(false);
		expect(isRecordableSessionId('x'.repeat(300))).toBe(false);
		expect(isRecordableSessionId('sess-2829-store')).toBe(true);
	});

	it('bounded prune: per-session file cap evicts oldest beyond the cap', () => {
		// Write cap+1 records with increasing mtimes into one session dir.
		const now = 4102444800000; // fixed future epoch: TTL-expired from these records' mtimes
		for (let i = 0; i <= MAX_STAGE_B_BINDING_FILES_PER_SESSION_DIR; i++) {
			const ok = recordStageBDispatchBindings(dir, {
				sessionID: SESSION,
				callID: `call-cap-${i}`,
				bindings: [{ taskId: '1.1', generation: i }],
			});
			expect(ok).toBe(true);
		}
		const sessionDir = path.dirname(recordPathFor(SESSION, 'call-cap-0'));
		const remaining = fs
			.readdirSync(sessionDir)
			.filter((f) => f.endsWith('.json'));
		expect(remaining.length).toBeLessThanOrEqual(
			MAX_STAGE_B_BINDING_FILES_PER_SESSION_DIR,
			MAX_STAGE_B_BINDING_SESSION_DIRS,
			isRecordableCallId,
		);
		// The oldest (call-cap-0) was evicted; the newest survives.
		expect(fs.existsSync(recordPathFor(SESSION, 'call-cap-0'))).toBe(false);
		expect(
			fs.existsSync(
				recordPathFor(
					SESSION,
					`call-cap-${MAX_STAGE_B_BINDING_FILES_PER_SESSION_DIR}`,
				),
			),
		).toBe(true);
		// Prune is callable directly and never throws on an empty store.
		expect(() =>
			storeInternals.pruneStore(dir, now + STAGE_B_BINDING_TTL_MS + 1),
		).not.toThrow();
	});

	it('rejects callIDs that are not a single safe path segment (no nested dirs)', () => {
		// Final-critic round-1 finding 1: a callID with a path separator
		// would nest directories under the session dir and escape both the
		// per-session cap and TTL pruning. Record/read/delete all refuse.
		expect(isRecordableCallId('nested-1/call')).toBe(false);
		const BS = String.fromCharCode(92); // a literal backslash, immune to formatter escape collapsing
		expect(isRecordableCallId('a' + BS + 'b')).toBe(false);
		expect(isRecordableCallId('..')).toBe(false);
		expect(isRecordableCallId('.')).toBe(false);
		expect(isRecordableCallId('')).toBe(false);
		expect(isRecordableCallId(undefined)).toBe(false);
		expect(isRecordableCallId('CON')).toBe(false);
		expect(isRecordableCallId('call-2829-ok')).toBe(true);
		for (const bad of ['nested-1/call', 'a' + BS + 'b', '..']) {
			expect(
				recordStageBDispatchBindings(dir, {
					sessionID: SESSION,
					callID: bad,
					bindings: [{ taskId: '1.1', generation: 1 }],
				}),
			).toBe(false);
			expect(readStageBDispatchBindings(dir, SESSION, bad)).toBeNull();
			expect(() =>
				deleteStageBDispatchBindings(dir, SESSION, bad),
			).not.toThrow();
		}
		// Nothing was written anywhere for the rejected callIDs.
		const sessionDir = path.dirname(recordPathFor(SESSION, 'probe'));
		expect(fs.existsSync(sessionDir)).toBe(false);
	});

	it('enforces the 128-session-dir cap on EVERY write (LRU sweep on overflow)', () => {
		// Final-critic round-1 finding 2: the 60 s sweep throttle alone let
		// session dirs accumulate unbounded between sweeps. The write path
		// counts the store root's dirs (one readdir) and forces the LRU
		// sweep the moment the cap is exceeded.
		for (let i = 0; i <= MAX_STAGE_B_BINDING_SESSION_DIRS; i++) {
			const ok = recordStageBDispatchBindings(dir, {
				sessionID: `sess-2829-cap-${i}`,
				callID: 'call-1',
				bindings: [{ taskId: '1.1', generation: i }],
			});
			expect(ok).toBe(true);
		}
		const storeRoot = path.dirname(
			path.dirname(recordPathFor(`sess-2829-cap-0`, 'call-1')),
		);
		const dirs = fs
			.readdirSync(storeRoot, { withFileTypes: true })
			.filter((e) => e.isDirectory());
		expect(dirs.length).toBeLessThanOrEqual(MAX_STAGE_B_BINDING_SESSION_DIRS);
	});

	it('a leftover same-directory temp file is never a read target', () => {
		recordStageBDispatchBindings(dir, {
			sessionID: SESSION,
			callID: CALL,
			bindings: [{ taskId: '1.1', generation: 1 }],
		});
		const p = recordPathFor(SESSION, CALL);
		fs.writeFileSync(`${p}.abcdef0123456789abcdef0123456789.tmp`, 'garbage');
		const read = readStageBDispatchBindings(dir, SESSION, CALL);
		expect(read?.bindings[0]?.generation).toBe(1);
	});
});
