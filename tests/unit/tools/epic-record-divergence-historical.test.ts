/**
 * `epic_record_divergence` must read the HISTORICAL declared scope.
 *
 * Divergence is recorded AFTER `update_task_status` completes a task. When
 * that task is the last one in its phase, completion advances
 * `current_phase`, which changes the plan structure hash — so the live
 * scheduling reader (`readDeclaredScopeFilesFromBindings`) no longer matches
 * the declaration. Bindings also expire after 1 h. The tool therefore uses
 * the Epic-owned `readLatestEpicDeclaredScopeForCalibration`
 * (`src/turbo/epic/declared-scopes.ts`), which keys on
 * `(taskId, planId)` only. Declarations go through the real `declare_scope`
 * path; completion goes through the real plan-manager `updateTaskStatus`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	loadPlanJsonOnly,
	savePlan,
	updateTaskStatus,
} from '../../../src/plan/manager';
import { readDeclaredScopeFilesFromBindings } from '../../../src/scope/scope-persistence';
import {
	_internals,
	executeEpicRecordDivergence,
} from '../../../src/tools/epic-record-divergence';
import { readLatestEpicDeclaredScopeForCalibration } from '../../../src/turbo/epic/declared-scopes';
import { readDivergenceHistory } from '../../../src/turbo/epic/divergence-recorder';
import {
	declareScopesForTest,
	resetDeclaredScopesForTest,
} from '../../helpers/declared-scope-bindings';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const realInternals = { ..._internals };
let dir: string;
let cleanup: () => void;

function twoPhasePlan(): Plan {
	const task = (id: string, phase: number, depends: string[] = []) => ({
		id,
		phase,
		status: 'pending' as const,
		size: 'small' as const,
		description: `Task ${id}`,
		depends,
		files_touched: [],
	});
	return {
		schema_version: '1.0.0',
		title: 'Divergence historical read',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{ id: 1, name: 'P1', status: 'pending', tasks: [task('1.1', 1)] },
			{ id: 2, name: 'P2', status: 'pending', tasks: [task('2.1', 2)] },
		],
		migration_status: 'native',
	} as Plan;
}

beforeEach(async () => {
	const created = createSafeTestDir('epic-divergence-historical-');
	dir = created.dir;
	cleanup = created.cleanup;
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	await savePlan(dir, twoPhasePlan());
	// Session-level Epic state is out of scope here; the declared-scope read
	// and the JSONL write are real.
	_internals.isEpicModeConfigEnabledForDirectory = () => true;
	_internals.hasActiveEpicMode = (() => true) as never;
	_internals.getAgentSession = (() => ({})) as never;
	_internals.getModifiedFilesForTask = (() => [
		'src/a.ts',
		'src/extra.ts',
	]) as never;
	_internals.resetModifiedFilesForTask = (() => {}) as never;
	// Only the stubbed architect session contributes attribution here.
	_internals.listAgentSessions = (() => []) as never;
});

afterEach(async () => {
	Object.assign(_internals, realInternals);
	await resetDeclaredScopesForTest();
	cleanup();
});

describe('epic_record_divergence — historical declared-scope read', () => {
	test('declare → complete the phase-closing task → divergence is recorded', async () => {
		await declareScopesForTest(dir, { '1.1': ['src/a.ts'] });
		const before = await loadPlanJsonOnly(dir);
		expect(before).not.toBeNull();
		expect(
			readDeclaredScopeFilesFromBindings({
				directory: dir,
				taskId: '1.1',
				plan: before as Plan,
			}),
		).toEqual(['src/a.ts']);

		await updateTaskStatus(dir, '1.1', 'completed');

		// The scenario is real: the live scheduling read no longer matches.
		const after = await loadPlanJsonOnly(dir);
		expect(after).not.toBeNull();
		expect(
			readDeclaredScopeFilesFromBindings({
				directory: dir,
				taskId: '1.1',
				plan: after as Plan,
			}),
		).toBeNull();

		const result = await executeEpicRecordDivergence({
			directory: dir,
			taskId: '1.1',
			sessionID: 'ses_divergence',
		});

		expect(result.reason).toBe('recorded');
		expect(result.summary?.declaredCount).toBe(1);
		expect(result.summary?.undeclaredCount).toBe(1);
		const history = readDivergenceHistory(dir);
		expect(history).toHaveLength(1);
		expect(history[0].declaredScope).toEqual(['src/a.ts']);
		expect(history[0].phaseNumber).toBe(1);
	});

	test('returns no-scope when the task was never declared', async () => {
		await updateTaskStatus(dir, '1.1', 'completed');
		const result = await executeEpicRecordDivergence({
			directory: dir,
			taskId: '1.1',
			sessionID: 'ses_divergence',
		});
		expect(result.reason).toBe('no-scope');
		expect(readDivergenceHistory(dir)).toHaveLength(0);
	});

	test('a stale v1 scope file is not a declared baseline', async () => {
		const scopesDir = path.join(dir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });
		fs.writeFileSync(
			path.join(scopesDir, 'scope-1.1.json'),
			JSON.stringify({ taskId: '1.1', files: ['src/a.ts'] }),
		);
		const result = await executeEpicRecordDivergence({
			directory: dir,
			taskId: '1.1',
			sessionID: 'ses_divergence',
		});
		expect(result.reason).toBe('no-scope');
	});
});

describe('readLatestEpicDeclaredScopeForCalibration', () => {
	test('returns the LATEST declaration and is keyed by plan id', async () => {
		await declareScopesForTest(dir, { '1.1': ['src/a.ts'] });
		// Re-declaration with replace semantics supersedes the first one.
		await declareScopesForTest(
			dir,
			{ '1.1': ['src/b.ts'] },
			{ replaceExisting: true },
		);
		const plan = twoPhasePlan();

		expect(
			readLatestEpicDeclaredScopeForCalibration({
				directory: dir,
				taskId: '1.1',
				plan,
			}),
		).toEqual(['src/b.ts']);
		expect(
			readLatestEpicDeclaredScopeForCalibration({
				directory: dir,
				taskId: '1.1',
				plan: { ...plan, title: 'Some other plan' },
			}),
		).toBeNull();
		expect(
			readLatestEpicDeclaredScopeForCalibration({
				directory: dir,
				taskId: '2.1',
				plan,
			}),
		).toBeNull();
	});
});
