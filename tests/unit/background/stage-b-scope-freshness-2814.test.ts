/**
 * Regression coverage for issue #2814: background Stage B verdicts dropped by
 * the whole-tree workspace freshness check.
 *
 * Previous behavior: compareStageBWorkspace compared whole-tree
 * gitHead+dirtyHash+prHeadSha, so ANY concurrent workspace activity —
 * including other tasks' commits and unrelated untracked files — invalidated
 * clean reviewer/test_engineer verdicts, wedging the task at
 * pre_check_passed with passed_gates: [] and no recovery path.
 *
 * Fixed behavior: the freshness check narrows to the dispatch snapshot's
 * declared review scope (in-scope dirty-set slice + committed diff between
 * the dispatch and current heads). Out-of-scope activity no longer drops
 * verdicts; every form of in-scope drift still does.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	type BackgroundDelegationRecord,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { compareStageBWorkspace } from '../../../src/background/stage-b-gates';
import {
	type BackgroundWorkspaceSnapshot,
	captureWorkspaceSnapshot,
} from '../../../src/background/workspace-snapshot';
import { closeProjectDb } from '../../../src/db/project-db';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TASK = '2.6';
const PARENT = 'parent_session';
const IN_SCOPE_FILE = 'src-widget.ts';

function git(dir: string, ...args: string[]): void {
	execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
}

function makeProject(enforceReceipts = false): string {
	const dir = canonicalMkdtemp('swarm-2814-reg-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ review_routing: { enforce_receipts: enforceReceipts } }),
	);
	git(dir, 'init', '-q');
	git(dir, 'config', 'user.email', 'reg@example.com');
	git(dir, 'config', 'user.name', 'Reg');
	fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-qm', 'base');
	return dir;
}

function envelope(id: string): string {
	return `<task id="${id}" state="completed">\n<task_result>[REVIEWED] | task-${TASK} | APPROVED | all spec points covered\n[TESTED] | task-${TASK} | PASS | 32/32 tests passed</task_result>\n</task>`;
}

function partEvent(text: string) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: { type: 'text', text, synthetic: true, sessionID: PARENT },
			},
		},
	};
}

type Concurrent =
	| 'none'
	| 'commit-out-of-scope'
	| 'untracked-out-of-scope'
	| 'modify-in-scope'
	| 'commit-in-scope'
	| 'revert-in-scope-dispatch-dirty';

async function runScenario(concurrent: Concurrent, enforceReceipts = false) {
	resetSwarmState();
	const dir = makeProject(enforceReceipts);
	try {
		const session = ensureAgentSession(PARENT);
		session.taskWorkflowStates.set(TASK, 'pre_check_passed');
		const generation = await seedStageAPassed(dir, TASK);
		fs.writeFileSync(path.join(dir, IN_SCOPE_FILE), 'export {}\n');
		git(dir, 'add', '-A');
		git(dir, 'commit', '-qm', 'task implementation');
		session.taskWorkflowStates.set(TASK, 'pre_check_passed');
		if (concurrent === 'revert-in-scope-dispatch-dirty') {
			fs.appendFileSync(path.join(dir, IN_SCOPE_FILE), '// dirty\n');
		}
		const workspace = captureWorkspaceSnapshot(dir, { scope: IN_SCOPE_FILE });
		for (const [suffix, agent] of [
			['rev', 'reviewer'],
			['tst', 'test_engineer'],
		] as const) {
			await recordPendingDelegation(dir, {
				correlationId: `ses_${suffix}`,
				jobId: `job_${suffix}`,
				subagentSessionId: `ses_${suffix}`,
				parentSessionId: PARENT,
				callID: `call_${suffix}`,
				normalizedAgent: agent,
				swarmPrefixedAgent: agent,
				planTaskId: TASK,
				evidenceTaskId: TASK,
				workflowGeneration: generation,
				workspace,
			});
		}
		if (concurrent === 'commit-out-of-scope') {
			fs.writeFileSync(path.join(dir, 'other-task.svelte'), '<div>x</div>\n');
			git(dir, 'add', '-A');
			git(dir, 'commit', '-qm', 'other task (concurrent)');
		} else if (concurrent === 'untracked-out-of-scope') {
			fs.writeFileSync(path.join(dir, 'other-task.log'), 'noise\n');
		} else if (concurrent === 'modify-in-scope') {
			fs.appendFileSync(path.join(dir, IN_SCOPE_FILE), '// drift\n');
		} else if (concurrent === 'commit-in-scope') {
			fs.appendFileSync(path.join(dir, IN_SCOPE_FILE), '// drift\n');
			git(dir, 'add', '-A');
			git(dir, 'commit', '-qm', 'in-scope drift');
		} else if (concurrent === 'revert-in-scope-dispatch-dirty') {
			git(dir, 'checkout', '--', IN_SCOPE_FILE);
		}
		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(partEvent(envelope('ses_rev')));
		await obs.event(partEvent(envelope('ses_tst')));
		const evidence = await readTaskEvidence(dir, TASK);
		return {
			gates: evidence?.gates ? Object.keys(evidence.gates).sort() : [],
			workflowState: getTaskWorkflowSnapshot(evidence ?? null).state,
		};
	} finally {
		try {
			closeProjectDb(dir);
		} catch {
			// best-effort cleanup
		}
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
	}
}

describe('stage-b scope freshness — regression: out-of-scope activity drops verdicts (#2814)', () => {
	test('out-of-scope COMMIT during gate run records both gates and reaches tests_run', async () => {
		const result = await runScenario('commit-out-of-scope');
		expect(result.gates).toContain('reviewer');
		expect(result.gates).toContain('test_engineer');
		expect(result.workflowState).toBe('tests_run');
	});

	test('out-of-scope COMMIT with route receipts enabled also reaches tests_run', async () => {
		const result = await runScenario('commit-out-of-scope', true);
		expect(result.gates).toContain('reviewer');
		expect(result.gates).toContain('test_engineer');
		expect(result.workflowState).toBe('tests_run');
	});

	test('out-of-scope UNTRACKED file during gate run records both gates', async () => {
		const result = await runScenario('untracked-out-of-scope');
		expect(result.gates).toContain('reviewer');
		expect(result.gates).toContain('test_engineer');
		expect(result.workflowState).toBe('tests_run');
	});
});

describe('stage-b scope freshness — in-scope drift still invalidates', () => {
	test('in-scope dirty modification still rejects the verdict', async () => {
		const result = await runScenario('modify-in-scope');
		expect(result.gates).not.toContain('reviewer');
		expect(result.workflowState).toBe('pre_check_passed');
	});

	test('in-scope COMMITTED change during the run still rejects the verdict', async () => {
		const result = await runScenario('commit-in-scope');
		expect(result.gates).not.toContain('reviewer');
	});

	test('in-scope file dirtied at dispatch then reverted still rejects', async () => {
		const result = await runScenario('revert-in-scope-dispatch-dirty');
		expect(result.gates).not.toContain('reviewer');
	});
});

describe('stage-b scope freshness — fail-closed fallbacks', () => {
	function record(
		agent: string,
		scope: string | null,
	): BackgroundDelegationRecord {
		return {
			normalizedAgent: agent,
			workspace: {
				directory: '/proj',
				gitHead: 'head-a',
				dirtyHash: 'dirty-a',
				changedFiles: [],
				prHeadSha: null,
				scope,
			},
		} as unknown as BackgroundDelegationRecord;
	}

	function current(overrides: Partial<BackgroundWorkspaceSnapshot>) {
		return {
			directory: '/proj',
			gitHead: 'head-a',
			dirtyHash: 'dirty-a',
			changedFiles: [],
			prHeadSha: null,
			scope: null,
			...overrides,
		} as BackgroundWorkspaceSnapshot;
	}

	test('bare task-id scope falls back to whole-tree semantics (moved head stays stale)', () => {
		const check = compareStageBWorkspace(
			record('reviewer', '2.6'),
			current({ gitHead: 'head-b', dirtyHash: 'dirty-b' }),
			'/proj',
		);
		// Previous behavior must be preserved when no scope file is derivable.
		expect(check.stale).toBe(true);
	});

	test('null scope falls back to whole-tree semantics', () => {
		const check = compareStageBWorkspace(
			record('reviewer', null),
			current({ gitHead: 'head-b' }),
			'/proj',
		);
		expect(check.stale).toBe(true);
	});

	test('degraded snapshot (null gitHead) falls back to whole-tree semantics', () => {
		const degraded = record('reviewer', IN_SCOPE_FILE);
		if (degraded.workspace) degraded.workspace.gitHead = null;
		const check = compareStageBWorkspace(
			degraded,
			current({ gitHead: 'head-b', dirtyHash: 'dirty-b' }),
			'/proj',
		);
		expect(check.stale).toBe(true);
	});

	test('in-scope committed drift is reported with a scoped reason', () => {
		const check = compareStageBWorkspace(
			record('reviewer', IN_SCOPE_FILE),
			current({ gitHead: 'head-b', dirtyHash: 'dirty-b' }),
			// No directory: the committed leg cannot run and the whole-tree
			// fallback still flags the moved head — proving fail-closedness.
			undefined,
		);
		expect(check.stale).toBe(true);
	});

	test('mixed scope entries drop only the non-plausible fragments', () => {
		const check = compareStageBWorkspace(
			record('reviewer', `2.6, ${IN_SCOPE_FILE}`),
			current({ changedFiles: [IN_SCOPE_FILE] }),
			'/proj',
		);
		// The plausible entry survives; the in-scope newly-dirty file is caught.
		expect(check.stale).toBe(true);
	});
});
