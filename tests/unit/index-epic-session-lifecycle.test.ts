/**
 * Session lifecycle ↔ durable Epic Mode rows (F-Liveness), through the real
 * plugin `event` hook.
 * File: tests/unit/index-epic-session-lifecycle.test.ts
 *
 * - `session.deleted` / `session.removed` clears ONLY that session's Epic row.
 * - `session.idle` refreshes a live Epic session's heartbeat so the project
 *   probe's staleness TTL only retires crashed/abandoned sessions.
 * - Both are Epic-only: with Epic disabled by config and no in-memory Epic
 *   flag on the session, neither touches the Epic rows (non-Epic users pay
 *   no SQLite I/O on session events).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getCoordinationState } from '../../src/db/coordination-store.js';
import { closeAllProjectDbs, getProjectDb } from '../../src/db/project-db.js';
import { ensureAgentSession, resetSwarmState } from '../../src/state.js';
import {
	EPIC_SESSION_STALE_TTL_MS,
	enableEpicMode,
	isEpicModeActiveForProject,
	loadEpicSessionState,
} from '../../src/turbo/epic/state.js';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../helpers/knowledge-real-host.js';
import { safeRmRecursive } from '../helpers/safe-test-dir.js';
import { freezeClock, type Restore } from '../helpers/test-clock.js';

const NAMESPACE = 'turbo.epic.session';
const EPIC_CONFIG = {
	turbo: { strategy: 'standard', epic: { mode: { enabled: true } } },
};

/**
 * Frozen instant for the row-aging tests: Epic rows are stamped via
 * `new Date().toISOString()` (pinned by `isoNow`) and the probe/heartbeat
 * judge staleness against `Date.now()` (pinned by `fixedNow`), so an aged
 * row is exactly TTL + 60 s old. Frozen only AFTER the plugin host boots.
 */
const FROZEN_NOW_ISO = '2026-06-01T12:00:00.000Z';
const FROZEN_NOW_MS = Date.parse(FROZEN_NOW_ISO);
/** Captured before any freeze — the `isoNow` spy pins `toISOString()`. */
const realToISOString = Date.prototype.toISOString;
let restoreClock: Restore | null = null;

function freezeClockAfterBoot(): void {
	restoreClock = freezeClock({
		fixedNow: FROZEN_NOW_MS,
		isoNow: FROZEN_NOW_ISO,
	});
}

/** Backdate one session's row past the TTL; call under the frozen clock. */
function ageRow(sessionID: string): string {
	const aged = realToISOString.call(
		new Date(FROZEN_NOW_MS - EPIC_SESSION_STALE_TTL_MS - 60_000),
	);
	getProjectDb(directory).run(
		'UPDATE coordination_state SET updated_at = ? WHERE namespace = ? AND entity_key = ?',
		[aged, NAMESPACE, sessionID],
	);
	return aged;
}
let directory = '';
let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>> | undefined;

beforeEach(() => {
	resetSwarmState();
	directory = createKnowledgeProject();
});

afterEach(async () => {
	restoreClock?.();
	restoreClock = null;
	try {
		await plugin?.hooks.dispose?.();
	} catch {
		// best-effort plugin teardown
	}
	plugin = undefined;
	closeAllProjectDbs();
	resetSwarmState();
	try {
		safeRmRecursive(directory);
	} catch {
		// Windows can briefly retain a plugin-init handle.
	}
});

describe('plugin event hook — Epic Mode session rows', () => {
	test('session.deleted clears only the deleted session’s Epic row', async () => {
		plugin = await bootKnowledgeHost(directory, EPIC_CONFIG);
		enableEpicMode(directory, 'ses_epic_gone');
		enableEpicMode(directory, 'ses_epic_alive');

		await plugin.hooks.event({
			event: {
				type: 'session.deleted',
				properties: { sessionID: 'ses_epic_gone' },
			},
		});

		expect(getCoordinationState(directory, NAMESPACE, 'ses_epic_gone')).toBe(
			null,
		);
		expect(loadEpicSessionState(directory, 'ses_epic_alive')?.active).toBe(
			true,
		);
	});

	test('session.idle refreshes an aged live Epic row (heartbeat)', async () => {
		plugin = await bootKnowledgeHost(directory, EPIC_CONFIG);
		freezeClockAfterBoot();
		enableEpicMode(directory, 'ses_epic_live');
		ensureAgentSession('ses_epic_live', 'architect').epicModeActive = true;
		const aged = ageRow('ses_epic_live');

		await plugin.hooks.event({
			event: {
				type: 'session.idle',
				properties: { sessionID: 'ses_epic_live' },
			},
		});

		const row = getCoordinationState(directory, NAMESPACE, 'ses_epic_live');
		expect(row?.updatedAt).not.toBe(aged);
		expect(row?.updatedAt).toBe(FROZEN_NOW_ISO);
		expect(
			loadEpicSessionState(directory, 'ses_epic_live')?.lastHeartbeatAt,
		).toBeDefined();
	});

	test('session.deleted clears the row when only the in-memory Epic flag is set', async () => {
		plugin = await bootKnowledgeHost(directory);
		enableEpicMode(directory, 'ses_flagged');
		ensureAgentSession('ses_flagged', 'architect').epicModeActive = true;

		await plugin.hooks.event({
			event: {
				type: 'session.deleted',
				properties: { sessionID: 'ses_flagged' },
			},
		});

		expect(getCoordinationState(directory, NAMESPACE, 'ses_flagged')).toBe(
			null,
		);
	});
});

describe('plugin event hook — non-Epic sessions skip Epic row I/O', () => {
	test('session.deleted leaves rows untouched when Epic is off and unflagged', async () => {
		plugin = await bootKnowledgeHost(directory);
		enableEpicMode(directory, 'ses_plain');

		await plugin.hooks.event({
			event: {
				type: 'session.deleted',
				properties: { sessionID: 'ses_plain' },
			},
		});

		expect(loadEpicSessionState(directory, 'ses_plain')?.active).toBe(true);
	});

	test('session.idle does not heartbeat a session without the Epic flag', async () => {
		plugin = await bootKnowledgeHost(directory, EPIC_CONFIG);
		freezeClockAfterBoot();
		enableEpicMode(directory, 'ses_unflagged');
		ensureAgentSession('ses_unflagged', 'architect');
		const aged = ageRow('ses_unflagged');

		await plugin.hooks.event({
			event: {
				type: 'session.idle',
				properties: { sessionID: 'ses_unflagged' },
			},
		});

		const row = getCoordinationState(directory, NAMESPACE, 'ses_unflagged');
		expect(row?.updatedAt).toBe(aged);
	});
});

describe('plugin init wires in-process Epic liveness into the project probe (F3)', () => {
	test('an aged row of a live in-process Epic session still counts as active', async () => {
		// Previously the probe went false after the 24 h TTL even while the
		// session (and its banner) was live: Rule 2 and Epic phase readiness
		// silently turned off (fail-open).
		plugin = await bootKnowledgeHost(directory, EPIC_CONFIG);
		freezeClockAfterBoot();
		enableEpicMode(directory, 'ses_long_idle');
		const session = ensureAgentSession('ses_long_idle', 'architect');
		ageRow('ses_long_idle');
		expect(isEpicModeActiveForProject(directory)).toBe(false);
		session.epicModeActive = true;
		expect(isEpicModeActiveForProject(directory)).toBe(true);
	});
});
