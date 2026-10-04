/**
 * epic_plan_waves × Epic v2 lifecycle: requires an open epic for the current
 * plan, fails closed on unreadable lifecycle state, and honours the epic's
 * wave-width cap (non-git epics run one task per wave, M-i).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	executeEpicPlanWaves,
} from '../../../src/tools/epic-plan-waves';
import { stubEpicRecord } from '../../helpers/epic-lifecycle';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originals = { ..._internals };
let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('epic-waves-lifecycle-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			phases: [
				{
					id: 1,
					tasks: ['1.1', '1.2', '1.3'].map((id) => ({
						id,
						status: 'pending',
						depends: [],
						files_touched: [`src/${id}.ts`],
					})),
				},
			],
		}),
	);
	_internals.loadPluginConfigWithMeta = (() => ({
		config: {
			turbo: {
				strategy: 'standard',
				epic: { mode: { enabled: true } },
				lean: { require_declared_scope: false },
			},
		},
	})) as never;
	_internals.isGitRepo = () => false;
	_internals.resolveEpicDeclaredScopes = (() => ({})) as never;
});

afterEach(() => {
	Object.assign(_internals, originals);
	fs.rmSync(dir, { recursive: true, force: true });
});

function epicWithWidth(maxParallel: number) {
	return stubEpicRecord({
		config: {
			commitPolicy: 'current-branch',
			isolation: maxParallel === 1 ? 'main-tree-nogit' : 'worktree',
			maxParallel,
		},
	});
}

describe('epic_plan_waves requires an open epic', () => {
	test('no open epic ⇒ epic-mode-not-active with the start remedy', async () => {
		_internals.getOpenEpic = (() => null) as never;
		const result = await executeEpicPlanWaves({ directory: dir, phase: 1 });
		expect(result.success).toBe(false);
		expect(result.reason).toBe('epic-mode-not-active');
		expect(result.errors?.[0]).toContain('/swarm epic start');
	});

	test('unreadable lifecycle state ⇒ epic-state-unreadable', async () => {
		_internals.getOpenEpic = (() => {
			throw new Error('multiple Epic lifecycle rows present');
		}) as never;
		const result = await executeEpicPlanWaves({ directory: dir, phase: 1 });
		expect(result.reason).toBe('epic-state-unreadable');
		expect(result.errors?.[0]).toContain(
			'multiple Epic lifecycle rows present',
		);
	});
});

describe('wave width follows the epic record', () => {
	test('width 4 ⇒ one wave of three disjoint tasks', async () => {
		_internals.getOpenEpic = (() => epicWithWidth(4)) as never;
		const result = await executeEpicPlanWaves({ directory: dir, phase: 1 });
		expect(result.success).toBe(true);
		expect(result.waves?.map((wave) => wave.taskIds)).toEqual([
			['1.1', '1.2', '1.3'],
		]);
	});

	test('non-git width 1 ⇒ one task per wave (serial)', async () => {
		_internals.getOpenEpic = (() => epicWithWidth(1)) as never;
		const result = await executeEpicPlanWaves({ directory: dir, phase: 1 });
		expect(result.success).toBe(true);
		expect(result.waves?.map((wave) => wave.taskIds)).toEqual([
			['1.1'],
			['1.2'],
			['1.3'],
		]);
	});
});
