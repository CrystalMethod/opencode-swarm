/**
 * `epic_record_divergence` — cross-session ACTUAL-file attribution.
 *
 * Upstream guardrails attribute foreground coder writes on the coder CHILD
 * session (`recordModifiedFileForTask(trackingSession, ...)` in
 * src/hooks/guardrails/tool-before.ts), not on the architect session the
 * tool runs in. The tool therefore unions the task's attribution across the
 * architect session and every same-project session (read-only), and refuses
 * to record a "clean" observation when no attribution exists anywhere.
 *
 * Real session state (`startAgentSession` + `recordModifiedFileForTask`) and
 * the real JSONL writer/reader; only Epic activation, the plan load, and the
 * declared-scope read go through the `_internals` seam.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	getAgentSession,
	getModifiedFilesForTask,
	recordModifiedFileForTask,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import {
	_internals,
	executeEpicRecordDivergence,
} from '../../../src/tools/epic-record-divergence';
import { readDivergenceHistory } from '../../../src/turbo/epic/divergence-recorder';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const realInternals = { ..._internals };
let dir: string;
let cleanup: () => void;

const ARCHITECT = 'ses_arch_attr';
const CHILD = 'ses_child_coder_attr';
const FOREIGN = 'ses_foreign_coder_attr';

function sessionOrThrow(id: string) {
	const session = getAgentSession(id);
	if (!session) throw new Error(`expected session ${id}`);
	return session;
}

function divergencePath(): string {
	return path.join(dir, '.swarm', 'epic', 'divergence.jsonl');
}

beforeEach(() => {
	const created = createSafeTestDir('epic-divergence-attribution-');
	dir = created.dir;
	cleanup = created.cleanup;
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });

	resetSwarmState();
	startAgentSession(ARCHITECT, 'architect');
	startAgentSession(CHILD, 'coder');
	startAgentSession(FOREIGN, 'coder');
	// Project-identity classes: architect + child share a project; the
	// foreign session belongs to another project.
	sessionOrThrow(ARCHITECT).owningProjectKey = 'project-a';
	sessionOrThrow(CHILD).owningProjectKey = 'project-a';
	sessionOrThrow(FOREIGN).owningProjectKey = 'project-b';

	_internals.isEpicModeConfigEnabledForDirectory = () => true;
	_internals.isEpicOpenForProject = (() => true) as never;
	_internals.loadPlanJsonOnly = (async () => ({
		swarm: 'sw',
		title: 'Attribution plan',
		phases: [{ id: 1, tasks: [{ id: '1.1' }] }],
	})) as never;
	_internals.readLatestEpicDeclaredScopeForCalibration = (() => [
		'src/a.ts',
	]) as never;
});

afterEach(() => {
	Object.assign(_internals, realInternals);
	resetSwarmState();
	cleanup();
});

describe('epic_record_divergence — cross-session attribution', () => {
	test('a foreground write attributed on the coder CHILD session is recorded', async () => {
		// The architect session holds only the empty slot that coder
		// delegation creates; the real write landed on the child.
		recordModifiedFileForTask(
			sessionOrThrow(CHILD),
			'1.1',
			path.join(dir, 'src', 'b.ts'),
			dir,
		);

		const result = await executeEpicRecordDivergence({
			directory: dir,
			taskId: '1.1',
			sessionID: ARCHITECT,
		});

		expect(result.reason).toBe('recorded');
		expect(result.summary?.actualCount).toBe(1);
		expect(result.summary?.undeclaredCount).toBe(1);
		expect(result.summary?.isClean).toBe(false);
		const history = readDivergenceHistory(dir);
		expect(history).toHaveLength(1);
		expect(history[0].actualFiles).toEqual(['src/b.ts']);
		expect(history[0].undeclared).toEqual(['src/b.ts']);
		// Read-only towards other sessions: the child's record is untouched.
		expect(getModifiedFilesForTask(sessionOrThrow(CHILD), '1.1')).toEqual([
			'src/b.ts',
		]);
	});

	test('architect and child attribution are unioned and de-duplicated', async () => {
		recordModifiedFileForTask(
			sessionOrThrow(ARCHITECT),
			'1.1',
			'src/a.ts',
			dir,
		);
		recordModifiedFileForTask(sessionOrThrow(CHILD), '1.1', 'src/a.ts', dir);
		recordModifiedFileForTask(sessionOrThrow(CHILD), '1.1', 'src/c.ts', dir);

		const result = await executeEpicRecordDivergence({
			directory: dir,
			taskId: '1.1',
			sessionID: ARCHITECT,
		});

		expect(result.reason).toBe('recorded');
		const history = readDivergenceHistory(dir);
		expect(history[0].actualFiles).toEqual(['src/a.ts', 'src/c.ts']);
		expect(history[0].undeclared).toEqual(['src/c.ts']);
	});

	test('no attribution anywhere → attribution-unavailable and divergence.jsonl untouched', async () => {
		const result = await executeEpicRecordDivergence({
			directory: dir,
			taskId: '1.1',
			sessionID: ARCHITECT,
		});

		expect(result.reason).toBe('attribution-unavailable');
		expect(result.summary).toBeUndefined();
		expect(fs.existsSync(divergencePath())).toBe(false);
		expect(readDivergenceHistory(dir)).toHaveLength(0);
	});

	test('attribution held only by an OTHER-project session is ignored', async () => {
		recordModifiedFileForTask(
			sessionOrThrow(FOREIGN),
			'1.1',
			'src/foreign.ts',
			dir,
		);

		const result = await executeEpicRecordDivergence({
			directory: dir,
			taskId: '1.1',
			sessionID: ARCHITECT,
		});

		expect(result.reason).toBe('attribution-unavailable');
		expect(fs.existsSync(divergencePath())).toBe(false);
		// The foreign session's record is never mutated.
		expect(getModifiedFilesForTask(sessionOrThrow(FOREIGN), '1.1')).toEqual([
			'src/foreign.ts',
		]);
	});

	test('other-project attribution does not leak into a same-project record', async () => {
		recordModifiedFileForTask(sessionOrThrow(CHILD), '1.1', 'src/a.ts', dir);
		recordModifiedFileForTask(
			sessionOrThrow(FOREIGN),
			'1.1',
			'src/foreign.ts',
			dir,
		);

		const result = await executeEpicRecordDivergence({
			directory: dir,
			taskId: '1.1',
			sessionID: ARCHITECT,
		});

		expect(result.reason).toBe('recorded');
		expect(result.summary?.isClean).toBe(true);
		expect(readDivergenceHistory(dir)[0].actualFiles).toEqual(['src/a.ts']);
	});

	test('attribution for a different task id does not count', async () => {
		recordModifiedFileForTask(sessionOrThrow(CHILD), '1.2', 'src/a.ts', dir);

		const result = await executeEpicRecordDivergence({
			directory: dir,
			taskId: '1.1',
			sessionID: ARCHITECT,
		});

		expect(result.reason).toBe('attribution-unavailable');
		expect(fs.existsSync(divergencePath())).toBe(false);
	});

	test('retry after a recorded call is idempotent; rework supersedes (F2, real recorder)', async () => {
		// Child attribution survives the architect-only reset, so a retried
		// call previously appended an identical second record.
		recordModifiedFileForTask(sessionOrThrow(CHILD), '1.1', 'src/b.ts', dir);
		const first = await executeEpicRecordDivergence({
			directory: dir,
			taskId: '1.1',
			sessionID: ARCHITECT,
		});
		const retry = await executeEpicRecordDivergence({
			directory: dir,
			taskId: '1.1',
			sessionID: ARCHITECT,
		});
		expect(first.reason).toBe('recorded');
		expect(retry.reason).toBe('already-recorded');
		expect(readDivergenceHistory(dir)).toHaveLength(1);

		// Rework after NEEDS_REVISION: the coder now also touches the
		// declared file — a different actual set appends a superseding record.
		recordModifiedFileForTask(sessionOrThrow(CHILD), '1.1', 'src/a.ts', dir);
		const rework = await executeEpicRecordDivergence({
			directory: dir,
			taskId: '1.1',
			sessionID: ARCHITECT,
		});
		expect(rework.reason).toBe('recorded');
		const history = readDivergenceHistory(dir);
		expect(history).toHaveLength(2);
		expect(history[1].actualFiles).toEqual(['src/a.ts', 'src/b.ts']);
		expect(history[0].planId).toBe(history[1].planId);
	});
});
