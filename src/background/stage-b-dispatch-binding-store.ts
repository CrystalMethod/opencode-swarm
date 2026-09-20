/**
 * Durable twin of the Stage B dispatch-generation bindings (issue #2829).
 *
 * `stageBDispatchGenerationsByCallID` (src/hooks/delegation-gate.ts) is a
 * closure-local `Map<callID, Map<taskId, generation>>` written at dispatch
 * time and read at settlement time; a plugin reload or host restart between
 * the two loses it and every post-restart foreground settlement arrives
 * `unbound` and is dropped fail-closed (issue #2817). This store is the
 * durable twin: `rememberStageBDispatchGenerations` persists the binding at
 * dispatch, and the settlement path reconstructs it lazily — feeding the
 * EXISTING `expectedGeneration` fence (`transitionTaskWorkflowEvidence`), so
 * a stale binding dies on `TASK_WORKFLOW_GENERATION_MISMATCH` exactly as an
 * in-process stale one would (AGENTS.md invariant 9: never the reverse).
 *
 * Layout: `.swarm/stage-b-dispatch-bindings/<sha256(sessionID).slice(0,24)>/
 * <callID>.json` — the scope-persistence path convention (hashed owner,
 * scope-persistence.ts:327-330); the raw sessionID never touches the path.
 * Writes are `atomicWriteSwarmFileSync` (temp-then-rename; a crash leaves
 * either the old complete record or no new one — the crash-window rule).
 * Reads are fail-closed: ANY anomaly (missing, oversized, unparsable,
 * wrong-version, wrong identity, TTL-stale) yields `null`, which keeps
 * today's unbound drop. No lockfile: single writer per (sessionID, callID),
 * and last-write-wins is the correct semantics (a re-dispatch under the same
 * callID replaces the binding).
 */

import { createHash } from 'node:crypto';
import {
	closeSync,
	existsSync,
	fstatSync,
	openSync,
	readdirSync,
	readSync,
	rmSync,
	statSync,
} from 'node:fs';
import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';
import { atomicWriteSwarmFileSync } from '../utils/atomic-write';

export const STAGE_B_BINDING_SCHEMA_VERSION = 1;
export const STAGE_B_BINDINGS_DIR = 'stage-b-dispatch-bindings';
/** Mirrors the in-memory per-callID cap (delegation-gate.ts MAX_PENDING_CODER_CHANGE_CONTEXTS). */
export const MAX_STAGE_B_BINDING_FILES_PER_SESSION_DIR = 128;
/** Independently bounded session-dir ceiling: 128 × 128 × ~256 B ≈ 4 MB worst case. */
export const MAX_STAGE_B_BINDING_SESSION_DIRS = 128;
export const STAGE_B_BINDING_MAX_BYTES = 64 * 1024;
export const STAGE_B_BINDING_TTL_MS = 24 * 60 * 60 * 1000;

const WINDOWS_RESERVED = new Set([
	'CON',
	'PRN',
	'AUX',
	'NUL',
	'COM1',
	'COM2',
	'COM3',
	'COM4',
	'COM5',
	'COM6',
	'COM7',
	'COM8',
	'COM9',
	'LPT1',
	'LPT2',
	'LPT3',
	'LPT4',
	'LPT5',
	'LPT6',
	'LPT7',
	'LPT8',
	'LPT9',
]);

export interface StageBDispatchBinding {
	taskId: string;
	generation: number;
}

interface PersistedStageBBindings {
	schemaVersion: number;
	sessionID: string;
	callID: string;
	recordedAt: number;
	bindings: StageBDispatchBinding[];
}

/** Path safety never depends on the raw sessionID (the path is always the hash); this rejects pathological inputs only. */
export function isRecordableSessionId(
	sessionID: string | undefined | null,
): sessionID is string {
	if (
		typeof sessionID !== 'string' ||
		sessionID.length === 0 ||
		sessionID.length > 256
	) {
		return false;
	}
	return !WINDOWS_RESERVED.has(sessionID.split('.')[0]!.toUpperCase());
}

function sessionDirName(sessionID: string): string {
	return createHash('sha256').update(sessionID).digest('hex').slice(0, 24);
}

function recordPath(
	directory: string,
	sessionID: string,
	callID: string,
): string {
	return validateSwarmPath(
		directory,
		`${STAGE_B_BINDINGS_DIR}/${sessionDirName(sessionID)}/${callID}.json`,
	);
}

/**
 * Persist the binding durably at dispatch time. NON-FATAL by design: the
 * in-memory map remains the primary fence; the durable twin only ADDS restart
 * recovery, so a transient fs failure degrades to today's behavior (logged,
 * debug-gated) instead of failing a working dispatch. `nowMs` is injectable
 * for tests.
 */
export function recordStageBDispatchBindings(
	directory: string,
	entry: {
		sessionID: string;
		callID: string;
		bindings: ReadonlyArray<StageBDispatchBinding>;
	},
	options: { nowMs?: () => number } = {},
): boolean {
	const { sessionID, callID } = entry;
	if (
		!isRecordableSessionId(sessionID) ||
		typeof callID !== 'string' ||
		callID.length === 0
	) {
		return false;
	}
	const bindings = entry.bindings.filter(
		(b) =>
			b &&
			typeof b.taskId === 'string' &&
			b.taskId.length > 0 &&
			Number.isFinite(b.generation) &&
			b.generation >= 0 &&
			Number.isInteger(b.generation),
	);
	if (bindings.length === 0) return false;
	const nowMs = options.nowMs ?? Date.now;
	const record: PersistedStageBBindings = {
		schemaVersion: STAGE_B_BINDING_SCHEMA_VERSION,
		sessionID,
		callID,
		recordedAt: nowMs(),
		bindings: bindings.map((b) => ({
			taskId: b.taskId,
			generation: b.generation,
		})),
	};
	try {
		const target = recordPath(directory, sessionID, callID);
		atomicWriteSwarmFileSync(target, JSON.stringify(record));
		pruneStore(directory, nowMs());
		return true;
	} catch {
		return false;
	}
}

/**
 * Validated read for the settlement path. Returns the record ONLY when every
 * check passes (version, identity, size, parse, TTL); any anomaly → null
 * (fail-closed to today's unbound drop — a partially-written record never
 * validates). The per-task lookup mirrors the in-memory shape:
 * `record.bindings.find((b) => b.taskId === taskId)?.generation`; a malformed
 * per-task entry is not-present for that task without invalidating the rest.
 */
export function readStageBDispatchBindings(
	directory: string,
	sessionID: string,
	callID: string,
	options: { nowMs?: () => number } = {},
): PersistedStageBBindings | null {
	if (
		!isRecordableSessionId(sessionID) ||
		typeof callID !== 'string' ||
		callID.length === 0
	) {
		return null;
	}
	let filePath: string;
	try {
		filePath = recordPath(directory, sessionID, callID);
	} catch {
		return null;
	}
	let fd: number | undefined;
	try {
		fd = openSync(filePath, 'r');
		const stats = fstatSync(fd);
		if (!stats.isFile() || stats.size > STAGE_B_BINDING_MAX_BYTES) return null;
		const buffer = Buffer.alloc(stats.size);
		let read = 0;
		while (read < stats.size) {
			const n = readSync(fd, buffer, read, stats.size - read, null);
			if (n <= 0) break;
			read += n;
		}
		const parsed = JSON.parse(
			buffer.subarray(0, read).toString('utf-8'),
		) as PersistedStageBBindings;
		if (
			parsed.schemaVersion !== STAGE_B_BINDING_SCHEMA_VERSION ||
			parsed.sessionID !== sessionID ||
			parsed.callID !== callID ||
			!Array.isArray(parsed.bindings)
		) {
			return null;
		}
		const nowMs = options.nowMs ?? Date.now;
		if (
			typeof parsed.recordedAt !== 'number' ||
			nowMs() - parsed.recordedAt > STAGE_B_BINDING_TTL_MS
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// already closed or inaccessible — nothing to do
			}
		}
	}
}

/** Settlement/cleanup eviction: unlink the record; missing is a no-op. */
export function deleteStageBDispatchBindings(
	directory: string,
	sessionID: string,
	callID: string,
): void {
	if (
		!isRecordableSessionId(sessionID) ||
		typeof callID !== 'string' ||
		callID.length === 0
	) {
		return;
	}
	try {
		const filePath = recordPath(directory, sessionID, callID);
		if (existsSync(filePath)) rmSync(filePath, { force: true });
	} catch {
		// best-effort eviction; TTL prune bounds stragglers
	}
}

/**
 * Bound the store: per-session-dir file cap (mirrors the in-memory callID
 * cap) + cross-session-dir cap (LRU by newest record) + TTL staleness.
 * Called opportunistically after each record; never throws into the caller.
 */
export function pruneStore(directory: string, nowMs: number): void {
	const storeRoot = validateSwarmPath(directory, STAGE_B_BINDINGS_DIR);
	let sessionDirs: string[];
	try {
		sessionDirs = readdirSync(storeRoot, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return;
	}
	let survivors: Array<{ name: string; newest: number }> = [];
	for (const dir of sessionDirs) {
		const dirPath = path.join(storeRoot, dir);
		let files: string[];
		try {
			files = readdirSync(dirPath).filter((f) => f.endsWith('.json'));
		} catch {
			continue;
		}
		const stamped: Array<{ file: string; mtime: number }> = [];
		for (const file of files) {
			const fp = path.join(dirPath, file);
			try {
				stamped.push({ file: fp, mtime: statSync(fp).mtimeMs });
			} catch {
				// unreadable — leave it to TTL
			}
		}
		const fresh = stamped.filter(
			(s) => nowMs - s.mtime <= STAGE_B_BINDING_TTL_MS,
		);
		for (const stale of stamped.filter(
			(s) => nowMs - s.mtime > STAGE_B_BINDING_TTL_MS,
		)) {
			try {
				rmSync(stale.file, { force: true });
			} catch {
				// best-effort
			}
		}
		if (fresh.length > MAX_STAGE_B_BINDING_FILES_PER_SESSION_DIR) {
			const ordered = fresh.sort((a, b) => a.mtime - b.mtime);
			for (const old of ordered.slice(
				0,
				fresh.length - MAX_STAGE_B_BINDING_FILES_PER_SESSION_DIR,
			)) {
				try {
					rmSync(old.file, { force: true });
				} catch {
					// best-effort
				}
			}
		}
		const newest = fresh.reduce((max, s) => Math.max(max, s.mtime), 0);
		survivors.push({ name: dirPath, newest });
	}
	survivors = survivors.filter((s) => s.newest > 0);
	if (survivors.length > MAX_STAGE_B_BINDING_SESSION_DIRS) {
		const ordered = survivors.sort((a, b) => a.newest - b.newest);
		for (const old of ordered.slice(
			0,
			survivors.length - MAX_STAGE_B_BINDING_SESSION_DIRS,
		)) {
			try {
				rmSync(old.name, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
	}
}

export const _internals = {
	recordPath,
	sessionDirName,
	pruneStore,
};
