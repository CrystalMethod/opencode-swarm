import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listCoordinationStates } from '../../../../src/db/coordination-store.js';
import { closeAllProjectDbs } from '../../../../src/db/project-db.js';
import {
	emptyPersisted,
	enableEpicMode,
	_internals as epicStateInternals,
	isEpicModeActiveForProject,
	loadEpicSessionState,
	recordEpicDecision,
	repairStateUnreadable,
} from '../../../../src/turbo/epic/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir.js';

const COORDINATION_NAMESPACE = 'turbo.epic.session';

let dir: string;
const originalConfigGate =
	epicStateInternals.isEpicModeConfigEnabledForDirectory;

beforeEach(() => {
	dir = canonicalMkdtemp('epic-state-sqlite-');
	repairStateUnreadable(dir);
	// Hold the `turbo.epic.mode.enabled` master gate open: these cases cover
	// SQLite authority, not the config gate (see state-liveness.test.ts).
	epicStateInternals.isEpicModeConfigEnabledForDirectory = () => true;
});

afterEach(() => {
	epicStateInternals.isEpicModeConfigEnabledForDirectory = originalConfigGate;
	repairStateUnreadable(dir);
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('epic state SQLite authority', () => {
	test('a session write stores one coordination row per session and refreshes the projection', () => {
		enableEpicMode(dir, 'sess-epic');

		const rows = listCoordinationStates(dir, COORDINATION_NAMESPACE);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.entityKey).toBe('sess-epic');

		const projected = JSON.parse(
			fs.readFileSync(path.join(dir, '.swarm', 'epic-state.json'), 'utf-8'),
		);
		expect(projected.sessions['sess-epic'].active).toBe(true);
	});

	test('legacy import archives the JSON file and project-scope status reads from SQLite afterwards', () => {
		const legacy = emptyPersisted();
		legacy.sessions['legacy-epic'] = {
			sessionID: 'legacy-epic',
			active: true,
			enabledAt: '2026-01-01T00:00:00.000Z',
		};

		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'epic-state.json'),
			`${JSON.stringify(legacy, null, 2)}\n`,
			'utf-8',
		);

		expect(loadEpicSessionState(dir, 'legacy-epic')?.active).toBe(true);
		expect(isEpicModeActiveForProject(dir)).toBe(true);
		expect(listCoordinationStates(dir, COORDINATION_NAMESPACE)).toHaveLength(1);
		expect(fs.existsSync(path.join(dir, '.swarm', 'epic-state.json'))).toBe(
			true,
		);
		expect(
			fs.existsSync(path.join(dir, '.swarm', 'epic-state.json.imported')),
		).toBe(true);
	});

	test('repairs a mismatched projection without overwriting the cold archive', () => {
		const state = { sessionID: 'archive-collision' };
		enableEpicMode(dir, state.sessionID);
		const filePath = path.join(dir, '.swarm', 'epic-state.json');
		const archivePath = `${filePath}.imported`;
		fs.writeFileSync(archivePath, 'original archive', 'utf-8');
		fs.writeFileSync(
			filePath,
			`${JSON.stringify(emptyPersisted())}\n`,
			'utf-8',
		);

		expect(loadEpicSessionState(dir, state.sessionID)?.active).toBe(true);
		expect(fs.readFileSync(archivePath, 'utf-8')).toBe('original archive');
		expect(fs.existsSync(`${archivePath}.1`)).toBe(true);
		expect(
			JSON.parse(fs.readFileSync(filePath, 'utf-8')).sessions[state.sessionID],
		).toBeDefined();
	});

	test('saving the same session twice advances revision/generation without duplicating rows', () => {
		enableEpicMode(dir, 'sess-epic');
		const first = listCoordinationStates(dir, COORDINATION_NAMESPACE)[0];

		recordEpicDecision(dir, 'sess-epic', {
			decidedAt: '2026-01-02T00:00:00.000Z',
			decision: 'promote',
			p: 0.1,
			blockingReasons: [],
		});
		const rows = listCoordinationStates(dir, COORDINATION_NAMESPACE);
		const second = rows[0];

		expect(rows).toHaveLength(1);
		expect(second?.revision).toBeGreaterThan(first?.revision ?? 0);
		expect(second?.generation).toBeGreaterThan(first?.generation ?? 0);
		expect(loadEpicSessionState(dir, 'sess-epic')?.lastDecision?.decision).toBe(
			'promote',
		);
	});
});
