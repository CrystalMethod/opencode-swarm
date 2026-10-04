/**
 * Durable Epic Mode session state.
 *
 * The authoritative store is the per-project SQLite coordination DB, with one
 * row per session. `.swarm/epic-state.json` remains a compatibility
 * projection and import source during the cutover.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	deleteCoordinationState,
	getCoordinationState,
	importCoordinationOnce,
	listCoordinationStates,
	transitionCoordinationState,
} from '../../db/coordination-store.js';
import { projectDbExists } from '../../db/project-db.js';
import { atomicWriteSwarmFileSync } from '../../utils/atomic-write.js';
import { canonicalRootKeyFresh } from '../../utils/canonical-root.js';
import * as logger from '../../utils/logger.js';
import { isEpicModeConfigEnabledForDirectory } from './config-gate.js';

/**
 * How Epic Mode was enabled for a session. `'turbo'` means the combined
 * `/swarm turbo epic on` toggle (so turning Turbo off also turns Epic off);
 * `'epic'` means the standalone `/swarm epic on` toggle (Turbo off leaves it
 * alone). Rows written before this field existed have it `undefined` and are
 * treated as standalone — never cross-cleared by a Turbo toggle.
 */
export type EpicEnabledVia = 'turbo' | 'epic';

/** Top-level state for a single session. */
export interface EpicSessionState {
	sessionID: string;
	/** When epic mode was last enabled for this session (ISO 8601). */
	enabledAt?: string;
	/** When epic mode was last disabled for this session (ISO 8601). */
	disabledAt?: string;
	/** Most recent activation decision recorded for this session, if any. */
	lastDecision?: EpicLastDecision;
	/** Whether epic mode is currently active for this session. */
	active: boolean;
	/** Which command enabled Epic Mode (absent on pre-existing rows). */
	enabledVia?: EpicEnabledVia;
	/**
	 * Last liveness heartbeat for this session (ISO 8601). Refreshed by
	 * {@link refreshEpicSessionHeartbeat} so a long-lived Epic session's row
	 * never ages past {@link EPIC_SESSION_STALE_TTL_MS}.
	 */
	lastHeartbeatAt?: string;
}

/** Minimal snapshot of the last activation decision. */
export interface EpicLastDecision {
	decidedAt: string;
	phase?: number;
	decision: 'promote' | 'demote';
	p: number;
	blockingReasons: string[];
}

/** Persisted shape of `.swarm/epic-state.json`. */
export interface EpicPersistedState {
	version: 1;
	updatedAt: string;
	sessions: Record<string, EpicSessionState>;
}

const STATE_FILE = 'epic-state.json';
const COORDINATION_NAMESPACE = 'turbo.epic.session';
const MAX_SESSION_WRITE_ATTEMPTS = 5;

/**
 * Staleness TTL for the project-scoped Epic probe
 * ({@link isEpicModeActiveForProject}). An active session row whose
 * coordination-row `updatedAt` is older than this is ignored: a session that
 * crashed (or was abandoned without a `session.deleted` event) must not keep
 * Epic-only behaviour — Rule 2 auto-commits, lean phase readiness — switched on
 * for every later non-Epic session in the project. 24 h comfortably exceeds
 * any single working session; live sessions refresh their row through
 * {@link refreshEpicSessionHeartbeat} (wired to the session `idle` lifecycle
 * event) at most every {@link EPIC_SESSION_HEARTBEAT_INTERVAL_MS}.
 */
export const EPIC_SESSION_STALE_TTL_MS = 24 * 60 * 60 * 1000;

/** Minimum interval between heartbeat writes for one live Epic session. */
export const EPIC_SESSION_HEARTBEAT_INTERVAL_MS = EPIC_SESSION_STALE_TTL_MS / 4;

/**
 * DI seam (AGENTS.md §7). `isEpicModeConfigEnabledForDirectory` is the
 * fail-closed `turbo.epic.mode.enabled` master gate; `now` drives staleness
 * so tests can age rows without sleeping. Restore in `afterEach`.
 */
export const _internals = {
	isEpicModeConfigEnabledForDirectory,
	now: (): number => Date.now(),
	/**
	 * True when the row's session is live in THIS process with the Epic flag
	 * set (in-memory, zero I/O). A live session's row is honoured past the
	 * staleness TTL — after a long idle stretch or a restart that restored
	 * the session from its snapshot — so the TTL only retires rows of
	 * crashed/abandoned sessions and never fails open on a live one.
	 *
	 * Wired by the plugin entry (`src/index.ts`) to the in-memory
	 * `swarmState` Epic flag. Not imported here on purpose: importing
	 * `src/state` from this module would drag the whole session-state graph
	 * into every importer of the probe (e.g. `src/plan/manager.ts`). Unwired
	 * (CLI / isolated tests) it answers `false` — TTL-only behaviour.
	 */
	isSessionLiveInProcess: (_sessionID: string): boolean => false,
};

function nowISO(): string {
	return new Date().toISOString();
}

function ensureSwarmDir(directory: string): string {
	const swarmDir = path.resolve(directory, '.swarm');
	if (!fs.existsSync(swarmDir)) {
		fs.mkdirSync(swarmDir, { recursive: true });
	}
	return swarmDir;
}

function stateFilePath(directory: string): string {
	return path.join(directory, '.swarm', STATE_FILE);
}

function importedStateFilePath(directory: string): string {
	return `${stateFilePath(directory)}.imported`;
}

function archiveStateFileWithoutOverwrite(directory: string): void {
	const filePath = stateFilePath(directory);
	if (!fs.existsSync(filePath)) return;
	const canonical = importedStateFilePath(directory);
	if (!fs.existsSync(canonical)) {
		fs.renameSync(filePath, canonical);
		return;
	}
	for (let suffix = 1; suffix <= 1_000; suffix += 1) {
		const candidate = `${canonical}.${suffix}`;
		if (fs.existsSync(candidate)) continue;
		fs.renameSync(filePath, candidate);
		return;
	}
	throw new Error('Epic state legacy archive collision limit exceeded');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePersistedShape(parsed: unknown): parsed is EpicPersistedState {
	return isRecord(parsed) && parsed.version === 1 && isRecord(parsed.sessions);
}

function parsePersistedJson(raw: string): EpicPersistedState {
	const parsed = JSON.parse(raw) as unknown;
	if (!validatePersistedShape(parsed)) {
		const maybe = parsed as Partial<EpicPersistedState> | undefined;
		throw new Error(
			`malformed shape (version=${maybe?.version}, sessions type=${Array.isArray(maybe?.sessions) ? 'array' : typeof maybe?.sessions})`,
		);
	}
	return {
		version: 1,
		updatedAt:
			typeof parsed.updatedAt === 'string' && parsed.updatedAt.length > 0
				? parsed.updatedAt
				: nowISO(),
		sessions: parsed.sessions,
	};
}

function parseSessionPayload(
	payload: string,
	entityKey: string,
): EpicSessionState {
	const parsed = JSON.parse(payload) as unknown;
	if (!isRecord(parsed) || parsed.sessionID !== entityKey) {
		throw new Error(
			`session payload malformed for ${entityKey}: sessionID mismatch`,
		);
	}
	return parsed as unknown as EpicSessionState;
}

function buildPersistedFromCoordination(
	directory: string,
): EpicPersistedState | null {
	const rows = listCoordinationStates(directory, COORDINATION_NAMESPACE);
	if (rows.length === 0) return null;
	const sessions: Record<string, EpicSessionState> = {};
	let updatedAt = '';
	for (const row of rows) {
		sessions[row.entityKey] = parseSessionPayload(row.payload, row.entityKey);
		if (!updatedAt || row.updatedAt > updatedAt) updatedAt = row.updatedAt;
	}
	return {
		version: 1,
		updatedAt: updatedAt || nowISO(),
		sessions,
	};
}

function readLegacyPersisted(
	directory: string,
): { persisted: EpicPersistedState; sourceDigest: string } | null {
	const filePath = stateFilePath(directory);
	if (!fs.existsSync(filePath)) return null;
	const raw = fs.readFileSync(filePath, 'utf-8');
	return {
		persisted: parsePersistedJson(raw),
		sourceDigest: createHash('sha256').update(raw).digest('hex'),
	};
}

function writeProjection(
	directory: string,
	persisted: EpicPersistedState,
): void {
	ensureSwarmDir(directory);
	const filePath = stateFilePath(directory);
	if (fs.existsSync(filePath) && fs.lstatSync(filePath).isDirectory()) {
		throw new Error(`${STATE_FILE} is a directory`);
	}
	const payload = `${JSON.stringify(persisted, null, 2)}\n`;
	// The SQLite row is authoritative; this compatibility projection still needs
	// the canonical bounded, fsynced, same-directory writer so readers never see
	// a torn JSON file and residue scanners see one stable temp grammar.
	atomicWriteSwarmFileSync(filePath, payload);
}

function seedProjectionBestEffort(
	directory: string,
	persisted: EpicPersistedState,
): void {
	try {
		writeProjection(directory, persisted);
	} catch {
		// best-effort seed for backward-compatible readers/tests
	}
}

function preflightProjectionTarget(directory: string): void {
	ensureSwarmDir(directory);
	const filePath = stateFilePath(directory);
	if (fs.existsSync(filePath) && fs.lstatSync(filePath).isDirectory()) {
		throw new Error(
			`Epic state persistence prepare failed: ${STATE_FILE} is a directory`,
		);
	}
}

function importLegacyStateIfNeeded(
	directory: string,
): EpicPersistedState | null {
	const legacy = readLegacyPersisted(directory);
	if (!legacy) return null;
	const outcome = importCoordinationOnce(
		directory,
		{
			source: STATE_FILE,
			sourceDigest: legacy.sourceDigest,
			rowCount: Object.keys(legacy.persisted.sessions).length,
			emptyNamespace: COORDINATION_NAMESPACE,
		},
		() => {
			for (const [sessionID, state] of Object.entries(
				legacy.persisted.sessions,
			)) {
				const result = transitionCoordinationState(directory, {
					namespace: COORDINATION_NAMESPACE,
					entityKey: sessionID,
					expectedRevision: null,
					generation: 1,
					status: state.active ? 'active' : 'inactive',
					payload: JSON.stringify(state),
				});
				if (result.outcome !== 'applied') {
					throw new Error('Epic legacy import conflict');
				}
			}
		},
	);
	if (outcome === 'imported') {
		archiveStateFileWithoutOverwrite(directory);
	}
	const authoritative =
		buildPersistedFromCoordination(directory) ?? emptyPersisted();
	seedProjectionBestEffort(directory, authoritative);
	return authoritative;
}

function unreadableStateError(directory: string): Error {
	return new Error(
		`Epic state is unreadable for ${directory}. Repair .swarm/${STATE_FILE} before continuing.`,
	);
}

function ensureReadableState(directory: string): void {
	if (stateUnreadableMap.get(stateKey(directory)))
		throw unreadableStateError(directory);
	if (!readPersisted(directory)) throw unreadableStateError(directory);
}

function refreshProjectionFromCoordination(directory: string): void {
	const persisted =
		buildPersistedFromCoordination(directory) ?? emptyPersisted();
	writeProjection(directory, persisted);
}

function saveSessionRowAtomic(
	directory: string,
	state: EpicSessionState,
): void {
	preflightProjectionTarget(directory);
	ensureReadableState(directory);
	for (let attempt = 0; attempt < MAX_SESSION_WRITE_ATTEMPTS; attempt++) {
		const current = getCoordinationState(
			directory,
			COORDINATION_NAMESPACE,
			state.sessionID,
		);
		const result = transitionCoordinationState(directory, {
			namespace: COORDINATION_NAMESPACE,
			entityKey: state.sessionID,
			expectedRevision: current?.revision ?? null,
			generation: (current?.generation ?? 0) + 1,
			status: state.active ? 'active' : 'inactive',
			payload: JSON.stringify(state),
		});
		if (result.outcome === 'applied') {
			refreshProjectionFromCoordination(directory);
			return;
		}
		if (
			result.outcome === 'revision_conflict' ||
			result.outcome === 'stale_generation'
		) {
			continue;
		}
		throw new Error(
			`Epic state persistence failed: ${result.outcome} for ${state.sessionID}`,
		);
	}
	throw new Error(
		`Epic state persistence failed: contention for ${state.sessionID}`,
	);
}

function mutateSessionRowAtomic(
	directory: string,
	sessionID: string,
	mutate: (state: EpicSessionState) => void,
): EpicSessionState | null {
	preflightProjectionTarget(directory);
	ensureReadableState(directory);
	for (let attempt = 0; attempt < MAX_SESSION_WRITE_ATTEMPTS; attempt++) {
		const current = getCoordinationState(
			directory,
			COORDINATION_NAMESPACE,
			sessionID,
		);
		if (!current) return null;
		const nextState = parseSessionPayload(current.payload, sessionID);
		mutate(nextState);
		const result = transitionCoordinationState(directory, {
			namespace: COORDINATION_NAMESPACE,
			entityKey: sessionID,
			expectedRevision: current.revision,
			generation: current.generation + 1,
			status: nextState.active ? 'active' : 'inactive',
			payload: JSON.stringify(nextState),
		});
		if (result.outcome === 'applied') {
			refreshProjectionFromCoordination(directory);
			return nextState;
		}
		if (
			result.outcome === 'revision_conflict' ||
			result.outcome === 'stale_generation'
		) {
			continue;
		}
		throw new Error(
			`Epic state persistence failed: ${result.outcome} for ${sessionID}`,
		);
	}
	throw new Error(`Epic state persistence failed: contention for ${sessionID}`);
}

export function emptyPersisted(): EpicPersistedState {
	return { version: 1, updatedAt: nowISO(), sessions: {} };
}

export function emptySessionState(sessionID: string): EpicSessionState {
	return { sessionID, active: false };
}

/**
 * Per-directory fail-closed marker. When canonical state is corrupt
 * (bad legacy JSON, malformed row payloads, import conflicts), we set a flag
 * and refuse to read it until the state is proven readable again: either a
 * teardown (`clearEpicSessionRow` / `clearAllEpicSessionRows`) rebuilds the
 * projection from the remaining rows, or `repairStateUnreadable` re-validates
 * the legacy file and every coordination row.
 */
const stateUnreadableMap = new Map<string, boolean>();

function stateKey(directory: string): string {
	return canonicalRootKeyFresh(directory);
}

export function isStateUnreadable(directory: string): boolean {
	return stateUnreadableMap.get(stateKey(directory)) ?? false;
}

function markStateUnreadable(directory: string, reason: string): void {
	stateUnreadableMap.set(stateKey(directory), true);
	logger.error(
		`[turbo/epic/state] state unreadable for ${directory}: ${reason} — failing closed`,
	);
}

export function repairStateUnreadable(directory: string): void {
	try {
		const filePath = stateFilePath(directory);
		if (fs.existsSync(filePath)) {
			parsePersistedJson(fs.readFileSync(filePath, 'utf-8'));
		}
		buildPersistedFromCoordination(directory);
		stateUnreadableMap.delete(stateKey(directory));
	} catch {
		stateUnreadableMap.set(stateKey(directory), true);
	}
}

function readPersisted(directory: string): EpicPersistedState | null {
	try {
		const coordinated = buildPersistedFromCoordination(directory);
		if (coordinated) {
			const filePath = stateFilePath(directory);
			if (fs.existsSync(filePath)) {
				let matches = false;
				try {
					matches =
						JSON.stringify(
							parsePersistedJson(fs.readFileSync(filePath, 'utf-8')),
						) === JSON.stringify(coordinated);
				} catch {
					matches = false;
				}
				if (!matches) archiveStateFileWithoutOverwrite(directory);
			}
			seedProjectionBestEffort(directory, coordinated);
			return coordinated;
		}
		const imported = importLegacyStateIfNeeded(directory);
		if (imported) return imported;
		const seed = emptyPersisted();
		seedProjectionBestEffort(directory, seed);
		return seed;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		markStateUnreadable(directory, reason);
		return null;
	}
}

/** Read this session's state, or null if not yet recorded. */
export function loadEpicSessionState(
	directory: string,
	sessionID: string,
): EpicSessionState | null {
	if (stateUnreadableMap.get(stateKey(directory))) return null;
	const persisted = readPersisted(directory);
	if (!persisted) return null;
	return persisted.sessions[sessionID] ?? null;
}

/** True iff epic mode is currently active for the given session. */
export function isEpicModeActive(
	directory: string,
	sessionID: string,
): boolean {
	const state = loadEpicSessionState(directory, sessionID);
	return state?.active === true;
}

function hasTraversalSegment(directory: string): boolean {
	return directory.split(/[\\/]/).includes('..');
}

/**
 * Read this session's Epic row without creating anything: returns `null`
 * (and touches no file or database) when the project has never persisted
 * Epic state. Otherwise identical to {@link loadEpicSessionState}.
 */
export function peekEpicSessionState(
	directory: string,
	sessionID: string,
): EpicSessionState | null {
	if (!sessionID || hasTraversalSegment(directory)) return null;
	if (stateUnreadableMap.get(stateKey(directory))) return null;
	let hasDb = false;
	try {
		hasDb = projectDbExists(directory);
	} catch {
		return null;
	}
	if (!hasDb && !fs.existsSync(stateFilePath(directory))) return null;
	return loadEpicSessionState(directory, sessionID);
}

function isRowFresh(updatedAt: string, nowMs: number): boolean {
	const ts = Date.parse(updatedAt);
	// Unparseable timestamps fail closed (treated as stale).
	if (!Number.isFinite(ts)) return false;
	return nowMs - ts <= EPIC_SESSION_STALE_TTL_MS;
}

/**
 * True iff Epic Mode is live for ANY session in the project.
 *
 * Project-scoped on purpose: sub-agent sessions (coders dispatched via
 * `Task`) never carry the architect's Epic flag, yet Rule 2 and phase
 * readiness must still know the project runs under Epic.
 *
 * Returns `false` when:
 *  - `turbo.epic.mode.enabled !== true` (the config master gate — with it
 *    off, no Epic Mode behaviour runs regardless of persisted rows; the
 *    config is only read once an Epic row is known to exist, so non-Epic
 *    projects pay no config I/O here),
 *  - every active row is older than {@link EPIC_SESSION_STALE_TTL_MS}
 *    (crashed / abandoned sessions) AND its session is not live in this
 *    process with the Epic flag set (a live in-process Epic session's row is
 *    honoured regardless of age — see `_internals.isSessionLiveInProcess`),
 *  - state is unreadable (fail-closed, matching the rest of this module).
 */
export function isEpicModeActiveForProject(directory: string): boolean {
	// This read-only probe is also called by a few direct tool entry points that
	// bypass `resolveWorkingDirectory`. Never follow raw traversal segments into
	// an ancestor's `.swarm/` database; the caller will fail closed at its normal
	// retrospective/project-root gate instead.
	if (hasTraversalSegment(directory)) return false;
	if (stateUnreadableMap.get(stateKey(directory))) return false;
	const hasLegacyFile = fs.existsSync(stateFilePath(directory));
	let hasCoordinationRows = false;
	try {
		// Avoid opening or creating a database for a project that has never
		// persisted coordination state, while still failing closed when an
		// existing database is corrupt or inaccessible.
		hasCoordinationRows =
			projectDbExists(directory) &&
			listCoordinationStates(directory, COORDINATION_NAMESPACE, 1).length > 0;
	} catch {
		return false;
	}
	if (!hasLegacyFile && !hasCoordinationRows) {
		return false;
	}
	if (!_internals.isEpicModeConfigEnabledForDirectory(directory)) return false;
	// readPersisted performs the one-time legacy import and validates every row
	// payload (marking the directory unreadable on corruption).
	const persisted = readPersisted(directory);
	if (!persisted) return false;
	let rows: ReturnType<typeof listCoordinationStates>;
	try {
		rows = listCoordinationStates(directory, COORDINATION_NAMESPACE);
	} catch {
		return false;
	}
	const nowMs = _internals.now();
	for (const row of rows) {
		const session = persisted.sessions[row.entityKey];
		if (session?.active !== true) continue;
		if (
			isRowFresh(row.updatedAt, nowMs) ||
			_internals.isSessionLiveInProcess(row.entityKey)
		)
			return true;
	}
	return false;
}

/**
 * Refresh the liveness heartbeat of an ACTIVE Epic session row so the
 * project probe keeps honouring it past {@link EPIC_SESSION_STALE_TTL_MS}.
 * Throttled: writes only when the row is older than
 * {@link EPIC_SESSION_HEARTBEAT_INTERVAL_MS}. Side-effect free (never creates
 * `.swarm/`, the project DB, or a row) when the session has no active row.
 * Returns `true` when a heartbeat was written. May throw on persistence
 * failure — lifecycle callers wrap it fail-open.
 */
export function refreshEpicSessionHeartbeat(
	directory: string,
	sessionID: string,
): boolean {
	if (!sessionID || hasTraversalSegment(directory)) return false;
	if (stateUnreadableMap.get(stateKey(directory))) return false;
	if (!projectDbExists(directory)) return false;
	const current = getCoordinationState(
		directory,
		COORDINATION_NAMESPACE,
		sessionID,
	);
	if (!current || current.status !== 'active') return false;
	const ts = Date.parse(current.updatedAt);
	const nowMs = _internals.now();
	if (Number.isFinite(ts) && nowMs - ts < EPIC_SESSION_HEARTBEAT_INTERVAL_MS) {
		return false;
	}
	const next = mutateSessionRowAtomic(directory, sessionID, (state) => {
		if (state.active === true) {
			state.lastHeartbeatAt = new Date(nowMs).toISOString();
		}
	});
	return next?.active === true;
}

/**
 * Revision-checked delete of one coordination row that does NOT parse any
 * row payload first, so a corrupt row (which makes the module fail closed)
 * can still be removed by the teardown paths. The JSON projection is then
 * refreshed best-effort.
 */
function deleteRowWithoutPayloadValidation(
	directory: string,
	sessionID: string,
): boolean {
	for (let attempt = 0; attempt < MAX_SESSION_WRITE_ATTEMPTS; attempt++) {
		const current = getCoordinationState(
			directory,
			COORDINATION_NAMESPACE,
			sessionID,
		);
		if (!current) return false;
		if (
			deleteCoordinationState(
				directory,
				COORDINATION_NAMESPACE,
				sessionID,
				current.revision,
			)
		) {
			return true;
		}
	}
	throw new Error(`Epic state persistence failed: contention for ${sessionID}`);
}

function refreshProjectionAfterTeardown(directory: string): void {
	try {
		refreshProjectionFromCoordination(directory);
		// A successful rebuild proves every remaining row parses, so a prior
		// fail-closed marker (e.g. set by the row just removed) is lifted.
		stateUnreadableMap.delete(stateKey(directory));
	} catch {
		// Remaining rows are still unreadable, or the projection target is
		// unwritable — the authoritative delete already happened. Drop the now
		// stale projection so a later legacy-import pass can never resurrect
		// the deleted session rows from it. Best-effort.
		try {
			const filePath = stateFilePath(directory);
			if (fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()) {
				fs.unlinkSync(filePath);
			}
		} catch {
			// best-effort
		}
	}
}

/**
 * Delete one session's Epic row (session end). Side-effect free when the
 * session has no row: never creates `.swarm/`, the project DB, or a legacy
 * import. Returns `true` when a row was removed. May throw on persistence
 * failure — lifecycle callers wrap it fail-open.
 */
export function clearEpicSessionRow(
	directory: string,
	sessionID: string,
): boolean {
	if (!sessionID || hasTraversalSegment(directory)) return false;
	if (!projectDbExists(directory)) return false;
	if (!deleteRowWithoutPayloadValidation(directory, sessionID)) return false;
	refreshProjectionAfterTeardown(directory);
	return true;
}

/**
 * Delete every session's Epic row in the project. Used by `/swarm close`
 * and `/swarm reset-session`, which tear down ALL in-memory agent sessions
 * (and their snapshot rows) — leaving their durable Epic rows behind would
 * keep the project-scoped probe answering "Epic active" for sessions no
 * process still considers Epic. Operates on the authoritative SQLite rows
 * only (never imports a legacy JSON file or creates a database) and never
 * parses row payloads, so a corrupt row is cleared too. Returns the number
 * of rows removed. May throw — callers report fail-open.
 */
export function clearAllEpicSessionRows(directory: string): number {
	if (hasTraversalSegment(directory)) return 0;
	if (!projectDbExists(directory)) return 0;
	const rows = listCoordinationStates(directory, COORDINATION_NAMESPACE);
	let removed = 0;
	for (const row of rows) {
		if (deleteRowWithoutPayloadValidation(directory, row.entityKey)) {
			removed += 1;
		}
	}
	if (removed > 0) refreshProjectionAfterTeardown(directory);
	return removed;
}

/** Options for {@link enableEpicMode}. */
export interface EnableEpicModeOptions {
	/**
	 * Which command enabled Epic Mode. Defaults to `'epic'` (standalone);
	 * `/swarm turbo epic on` passes `'turbo'` so that turning Turbo off later
	 * cross-clears Epic only when Turbo was what turned it on.
	 */
	enabledVia?: EpicEnabledVia;
}

/**
 * Enable epic mode for the session; records `enabledAt` and `enabledVia`.
 * Re-enabling an ALREADY-ACTIVE session keeps the first enabler's
 * `enabledVia` (e.g. `/swarm turbo epic on` after a standalone
 * `/swarm epic on` stays `'epic'`, so a later `/swarm turbo off` does not
 * cross-clear the user's standalone enablement).
 */
export function enableEpicMode(
	directory: string,
	sessionID: string,
	options: EnableEpicModeOptions = {},
): void {
	const enabledVia: EpicEnabledVia = options.enabledVia ?? 'epic';
	const current = loadEpicSessionState(directory, sessionID);
	if (!current) {
		saveSessionRowAtomic(directory, {
			...emptySessionState(sessionID),
			active: true,
			enabledAt: nowISO(),
			disabledAt: undefined,
			enabledVia,
		});
		return;
	}
	mutateSessionRowAtomic(directory, sessionID, (state) => {
		const alreadyActive = state.active === true;
		state.active = true;
		state.enabledAt = nowISO();
		state.disabledAt = undefined;
		if (!alreadyActive) state.enabledVia = enabledVia;
	});
}

/** Disable epic mode for the session; records `disabledAt`. */
export function disableEpicMode(directory: string, sessionID: string): void {
	const current = loadEpicSessionState(directory, sessionID);
	if (!current) {
		// Nothing to disable — record an inactive state for telemetry parity.
		saveSessionRowAtomic(directory, {
			...emptySessionState(sessionID),
			disabledAt: nowISO(),
		});
		return;
	}
	mutateSessionRowAtomic(directory, sessionID, (state) => {
		state.active = false;
		state.disabledAt = nowISO();
	});
}

/**
 * Update the session's `lastDecision` field. Used by `epic_decide_phase`
 * after each activation evaluation so `/swarm epic status` can show the most recent
 * decision rationale without re-reading the evidence JSONL.
 *
 * Precondition: the session must already have an entry (i.e. the caller has
 * called `enableEpicMode` previously). This is intentional — recording a
 * decision for a never-toggled session would produce phantom state that
 * `/swarm epic status` could not distinguish from a legitimately-active
 * session. Callers that reach this function should have already verified
 * `isEpicModeActive(...)` returned `true`. Throws if no session entry exists.
 */
export function recordEpicDecision(
	directory: string,
	sessionID: string,
	decision: EpicLastDecision,
): void {
	const current = loadEpicSessionState(directory, sessionID);
	if (!current) {
		throw new Error(
			`Cannot record decision for sessionID '${sessionID}': no session entry exists. Call enableEpicMode first.`,
		);
	}
	mutateSessionRowAtomic(directory, sessionID, (state) => {
		state.lastDecision = decision;
	});
}
