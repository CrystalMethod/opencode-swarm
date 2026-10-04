/**
 * Epic Mode project-probe liveness — regression coverage for the Epic
 * catch-up review (F-Liveness).
 * File: tests/unit/turbo/epic/state-liveness.test.ts
 *
 * Previously `isEpicModeActiveForProject` returned true when ANY persisted
 * session row was active, with no liveness and no config gate, and nothing
 * ever cleared rows — so a crashed Epic session left Rule 2 auto-commits and
 * lean phase readiness on for every later non-Epic session.
 *
 * Covers: config master gate (fail-closed, lazily read), staleness TTL,
 * heartbeat refresh/throttle, per-session and project-wide row clearing
 * (including corrupt rows), `enabledVia` provenance, side-effect-free peek.
 *
 * Isolation: `_internals` seams on state.ts / config-gate.ts restored in
 * `afterEach` (AGENTS.md §7); real SQLite under a temp dir.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../../src/config/schema';
import { transitionCoordinationState } from '../../../../src/db/coordination-store';
import {
	closeAllProjectDbs,
	getProjectDb,
} from '../../../../src/db/project-db';
import { deserializeAgentSession } from '../../../../src/session/snapshot-reader';
import { serializeAgentSession } from '../../../../src/session/snapshot-writer';
import {
	ensureAgentSession,
	hasActiveEpicMode,
	resetSwarmState,
	swarmState,
} from '../../../../src/state';
import { _internals as configGateInternals } from '../../../../src/turbo/epic/config-gate';
import {
	clearAllEpicSessionRows,
	clearEpicSessionRow,
	disableEpicMode,
	EPIC_SESSION_HEARTBEAT_INTERVAL_MS,
	EPIC_SESSION_STALE_TTL_MS,
	enableEpicMode,
	_internals as epicStateInternals,
	isEpicModeActiveForProject,
	isStateUnreadable,
	loadEpicSessionState,
	peekEpicSessionState,
	refreshEpicSessionHeartbeat,
	repairStateUnreadable,
} from '../../../../src/turbo/epic/state';
import { freezeClock, type Restore } from '../../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const HOUR = 60 * 60 * 1000;
/**
 * Frozen instant for every test: Epic rows are stamped via
 * `new Date().toISOString()` (pinned by `isoNow`) and staleness is judged
 * against `_internals.now()` → `Date.now()` (pinned by `fixedNow`), so row
 * age is exact rather than "wall clock minus however long setup took".
 */
const FROZEN_NOW_ISO = '2026-06-01T12:00:00.000Z';
const FROZEN_NOW_MS = Date.parse(FROZEN_NOW_ISO);
/**
 * Captured before any freeze: the `isoNow` spy pins every
 * `toISOString()` call, so fixture backdates format through the original.
 */
const realToISOString = Date.prototype.toISOString;
let restoreClock: Restore | null = null;
const originalStateInternals = { ...epicStateInternals };
const originalLoader = configGateInternals.loadPluginConfigWithMeta;

let dir: string;

function configWithEpic(enabled: boolean | undefined) {
	return {
		config: {
			turbo:
				enabled === undefined
					? undefined
					: { strategy: 'standard', epic: { mode: { enabled } } },
		} as unknown as PluginConfig,
	} as ReturnType<typeof originalLoader>;
}

/** Fixture-level backdate of one session's authoritative row timestamp. */
function backdateRow(sessionID: string, ageMs: number): void {
	getProjectDb(dir).run(
		'UPDATE coordination_state SET updated_at = ? WHERE namespace = ? AND entity_key = ?',
		[
			realToISOString.call(new Date(FROZEN_NOW_MS - ageMs)),
			'turbo.epic.session',
			sessionID,
		],
	);
}

beforeEach(() => {
	restoreClock = freezeClock({
		fixedNow: FROZEN_NOW_MS,
		isoNow: FROZEN_NOW_ISO,
	});
	dir = canonicalMkdtemp('epic-liveness-');
	epicStateInternals.isEpicModeConfigEnabledForDirectory = () => true;
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	Object.assign(epicStateInternals, originalStateInternals);
	configGateInternals.loadPluginConfigWithMeta = originalLoader;
	repairStateUnreadable(dir);
	closeAllProjectDbs();
	resetSwarmState();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('config master gate (turbo.epic.mode.enabled)', () => {
	beforeEach(() => {
		// Exercise the REAL gate; only its config loader is substituted.
		epicStateInternals.isEpicModeConfigEnabledForDirectory =
			originalStateInternals.isEpicModeConfigEnabledForDirectory;
	});

	test('active fresh row + mode.enabled absent/false → false; true → true', () => {
		enableEpicMode(dir, 'architect');
		configGateInternals.loadPluginConfigWithMeta = () =>
			configWithEpic(undefined);
		expect(isEpicModeActiveForProject(dir)).toBe(false);
		configGateInternals.loadPluginConfigWithMeta = () => configWithEpic(false);
		expect(isEpicModeActiveForProject(dir)).toBe(false);
		configGateInternals.loadPluginConfigWithMeta = () => configWithEpic(true);
		expect(isEpicModeActiveForProject(dir)).toBe(true);
	});

	test('config load failure fails closed', () => {
		enableEpicMode(dir, 'architect');
		configGateInternals.loadPluginConfigWithMeta = () => {
			throw new Error('bad config');
		};
		expect(isEpicModeActiveForProject(dir)).toBe(false);
	});

	test('config is not read at all when the project has no Epic state', () => {
		let reads = 0;
		configGateInternals.loadPluginConfigWithMeta = () => {
			reads += 1;
			return configWithEpic(true);
		};
		expect(isEpicModeActiveForProject(dir)).toBe(false);
		expect(reads).toBe(0);
		expect(fs.existsSync(path.join(dir, '.swarm'))).toBe(false);
	});
});

describe('staleness TTL', () => {
	test('an active row older than the TTL is ignored (crashed session)', () => {
		enableEpicMode(dir, 'crashed');
		expect(isEpicModeActiveForProject(dir)).toBe(true);
		epicStateInternals.now = () =>
			FROZEN_NOW_MS + EPIC_SESSION_STALE_TTL_MS + HOUR;
		expect(isEpicModeActiveForProject(dir)).toBe(false);
	});

	test('one stale + one fresh active row → still active; the stale one alone is not', () => {
		enableEpicMode(dir, 'crashed');
		// Age ONLY the crashed session's row (fixture-level backdate of the
		// authoritative coordination row timestamp).
		backdateRow('crashed', EPIC_SESSION_STALE_TTL_MS + HOUR);
		expect(isEpicModeActiveForProject(dir)).toBe(false);
		enableEpicMode(dir, 'live');
		expect(isEpicModeActiveForProject(dir)).toBe(true);
	});
});

describe('in-process liveness overrides the TTL (F3 fail-open fix)', () => {
	// Previously an aged row of a LIVE Epic session (>TTL idle, or a restart)
	// made the probe return false while the banner still showed: Rule 2 was
	// skipped and epic_phase_readiness became not-applicable (fail-open).
	// The plugin entry wires this seam to `hasActiveEpicMode`; mirror that
	// wiring here (the index-level wiring is pinned in
	// tests/unit/index-epic-session-lifecycle.test.ts).
	beforeEach(() => {
		epicStateInternals.isSessionLiveInProcess = (sessionID) =>
			hasActiveEpicMode(sessionID);
	});

	test('aged row + in-process live Epic session → true', () => {
		enableEpicMode(dir, 'live');
		ensureAgentSession('live', 'architect').epicModeActive = true;
		backdateRow('live', EPIC_SESSION_STALE_TTL_MS + HOUR);
		expect(isEpicModeActiveForProject(dir)).toBe(true);
	});

	test('aged row without an in-process Epic session → false', () => {
		enableEpicMode(dir, 'gone');
		ensureAgentSession('gone', 'architect'); // live, but Epic flag unset
		backdateRow('gone', EPIC_SESSION_STALE_TTL_MS + HOUR);
		expect(isEpicModeActiveForProject(dir)).toBe(false);
	});

	test('unwired seam (CLI / no plugin entry) keeps TTL-only behaviour', () => {
		epicStateInternals.isSessionLiveInProcess =
			originalStateInternals.isSessionLiveInProcess;
		enableEpicMode(dir, 'live');
		ensureAgentSession('live', 'architect').epicModeActive = true;
		backdateRow('live', EPIC_SESSION_STALE_TTL_MS + HOUR);
		expect(isEpicModeActiveForProject(dir)).toBe(false);
	});

	test('restart: session restored from its snapshot with epicModeActive → true', () => {
		enableEpicMode(dir, 'restored');
		const live = ensureAgentSession('restored', 'architect');
		live.epicModeActive = true;
		const snapshot = serializeAgentSession(live);
		resetSwarmState(); // process restart: in-memory sessions gone
		backdateRow('restored', EPIC_SESSION_STALE_TTL_MS + HOUR);
		expect(isEpicModeActiveForProject(dir)).toBe(false);
		swarmState.agentSessions.set('restored', deserializeAgentSession(snapshot));
		expect(isEpicModeActiveForProject(dir)).toBe(true);
	});

	test('an inactive row is not revived by the in-process flag', () => {
		enableEpicMode(dir, 'off');
		disableEpicMode(dir, 'off');
		ensureAgentSession('off', 'architect').epicModeActive = true;
		expect(isEpicModeActiveForProject(dir)).toBe(false);
	});
});

describe('refreshEpicSessionHeartbeat', () => {
	test('throttled: no write while the row is younger than the interval', () => {
		enableEpicMode(dir, 'live');
		expect(refreshEpicSessionHeartbeat(dir, 'live')).toBe(false);
		expect(loadEpicSessionState(dir, 'live')?.lastHeartbeatAt).toBeUndefined();
	});

	test('a live session past the TTL is revived by its heartbeat (lifecycle idle event)', () => {
		enableEpicMode(dir, 'live');
		backdateRow('live', EPIC_SESSION_STALE_TTL_MS + HOUR);
		expect(isEpicModeActiveForProject(dir)).toBe(false);
		expect(refreshEpicSessionHeartbeat(dir, 'live')).toBe(true);
		expect(loadEpicSessionState(dir, 'live')?.lastHeartbeatAt).toBe(
			FROZEN_NOW_ISO,
		);
		expect(isEpicModeActiveForProject(dir)).toBe(true);
	});

	test('writes once the interval has elapsed even before the TTL', () => {
		enableEpicMode(dir, 'live');
		backdateRow('live', EPIC_SESSION_HEARTBEAT_INTERVAL_MS + HOUR);
		expect(refreshEpicSessionHeartbeat(dir, 'live')).toBe(true);
		// Freshly written → throttled again.
		expect(refreshEpicSessionHeartbeat(dir, 'live')).toBe(false);
	});

	test('no-op without an active row, and never creates .swarm', () => {
		expect(refreshEpicSessionHeartbeat(dir, 'nobody')).toBe(false);
		expect(fs.existsSync(path.join(dir, '.swarm'))).toBe(false);
		enableEpicMode(dir, 'off');
		disableEpicMode(dir, 'off');
		epicStateInternals.now = () => FROZEN_NOW_MS + EPIC_SESSION_STALE_TTL_MS;
		expect(refreshEpicSessionHeartbeat(dir, 'off')).toBe(false);
		expect(loadEpicSessionState(dir, 'off')?.active).toBe(false);
	});
});

describe('row clearing', () => {
	test('clearEpicSessionRow removes only that session', () => {
		enableEpicMode(dir, 'a');
		enableEpicMode(dir, 'b');
		expect(clearEpicSessionRow(dir, 'a')).toBe(true);
		expect(loadEpicSessionState(dir, 'a')).toBeNull();
		expect(loadEpicSessionState(dir, 'b')?.active).toBe(true);
		expect(clearEpicSessionRow(dir, 'a')).toBe(false);
	});

	test('clearEpicSessionRow is side-effect free for a project without Epic state', () => {
		expect(clearEpicSessionRow(dir, 'x')).toBe(false);
		expect(fs.existsSync(path.join(dir, '.swarm'))).toBe(false);
		expect(clearAllEpicSessionRows(dir)).toBe(0);
		expect(fs.existsSync(path.join(dir, '.swarm'))).toBe(false);
	});

	test('clearAllEpicSessionRows removes every row, including a corrupt one, and lifts fail-closed', () => {
		enableEpicMode(dir, 'a');
		const corrupt = transitionCoordinationState(dir, {
			namespace: 'turbo.epic.session',
			entityKey: 'corrupt',
			expectedRevision: null,
			generation: 1,
			status: 'active',
			payload: JSON.stringify({ sessionID: 'someone-else', active: true }),
		});
		expect(corrupt.outcome).toBe('applied');
		expect(isEpicModeActiveForProject(dir)).toBe(false);
		expect(isStateUnreadable(dir)).toBe(true);

		expect(clearAllEpicSessionRows(dir)).toBe(2);
		expect(isStateUnreadable(dir)).toBe(false);
		expect(isEpicModeActiveForProject(dir)).toBe(false);
		const projection = JSON.parse(
			fs.readFileSync(path.join(dir, '.swarm', 'epic-state.json'), 'utf-8'),
		);
		expect(projection.sessions).toEqual({});
	});
});

describe('enabledVia provenance and peek', () => {
	test('enableEpicMode defaults to epic; while active the FIRST enabler is kept; re-enable after disable records the new one', () => {
		enableEpicMode(dir, 's');
		expect(loadEpicSessionState(dir, 's')?.enabledVia).toBe('epic');
		enableEpicMode(dir, 's', { enabledVia: 'turbo' });
		expect(loadEpicSessionState(dir, 's')?.enabledVia).toBe('epic');
		disableEpicMode(dir, 's');
		enableEpicMode(dir, 's', { enabledVia: 'turbo' });
		expect(loadEpicSessionState(dir, 's')?.enabledVia).toBe('turbo');
		enableEpicMode(dir, 's');
		expect(loadEpicSessionState(dir, 's')?.enabledVia).toBe('turbo');
	});

	test('peekEpicSessionState creates nothing for a project without Epic state', () => {
		expect(peekEpicSessionState(dir, 's')).toBeNull();
		expect(fs.existsSync(path.join(dir, '.swarm'))).toBe(false);
		enableEpicMode(dir, 's', { enabledVia: 'turbo' });
		expect(peekEpicSessionState(dir, 's')?.enabledVia).toBe('turbo');
	});
});
