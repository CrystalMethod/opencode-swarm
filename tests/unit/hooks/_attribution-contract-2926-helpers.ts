/**
 * Shared fixtures for the #2926 attribution session-identity contract suites.
 *
 * Extracted from tests/unit/hooks/attribution-session-contract-2926.test.ts
 * (FR-006 500-line test-file cap) so the gate-level suite and its handler
 * sibling (attribution-session-contract-2926.handler.test.ts) reuse one
 * fixture set. Non-test module: the cap only applies to `*.test.ts` files
 * (precedent: _advisory-injection-helpers.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import {
	buildReviewRouteReceipt,
	persistReviewRouteReceipt,
} from '../../../src/review/routing-enforcement';
import {
	advanceTaskState,
	ensureAgentSession,
	recordModifiedFilesForTask,
	recordStageBCompletion,
	recordStageBRouteEvidence,
} from '../../../src/state';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir.js';

export function mkTempDir(): string {
	return canonicalMkdtemp('attribution-contract-2926-');
}

export function run(cmd: string[], cwd: string): number {
	const proc = Bun.spawnSync(cmd, { cwd, stdout: 'ignore', stderr: 'ignore' });
	const code = proc.exitCode ?? 0;
	if (code !== 0) {
		throw new Error(`git fixture command failed (${code}): ${cmd.join(' ')}`);
	}
	return code;
}

export async function gitInit(cwd: string): Promise<void> {
	run(['git', 'init'], cwd);
	run(['git', 'config', 'user.email', 'test@test.com'], cwd);
	run(['git', 'config', 'user.name', 'Test'], cwd);
	fs.writeFileSync(path.join(cwd, 'dummy.txt'), 'initial');
	run(['git', 'add', '.'], cwd);
	run(['git', 'commit', '-m', 'initial'], cwd);
}

export function commitFile(cwd: string, file: string): void {
	const fullPath = path.join(cwd, file);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, `content of ${file}`);
	run(['git', 'add', file], cwd);
	run(['git', 'commit', '-m', `add ${file}`], cwd);
}

export function createPlanJson(
	cwd: string,
	taskId: string,
	scope: string[],
): void {
	// Schema-valid RuntimePlan shape (mirrors the adversarial-v2 fixture) so
	// the handler-level tests can load the plan through the real loadPlan.
	const plan = {
		schema_version: '1.0.0',
		title: 'Attribution Contract Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: taskId,
						phase: 1,
						status: 'in_progress',
						size: 'small',
						description: 'test task',
						depends: [],
						files_touched: scope,
					},
				],
			},
		],
	};
	fs.mkdirSync(path.join(cwd, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

/** Foreign-latest-commit fixture: task scope [src/a.ts], latest commit src/b.ts. */
export async function foreignCommitFixture(
	cwd: string,
	taskId: string,
): Promise<void> {
	await gitInit(cwd);
	commitFile(cwd, 'src/a.ts');
	commitFile(cwd, 'src/b.ts');
	createPlanJson(cwd, taskId, ['src/a.ts']);
}

/** Clean fixture: the repo-wide set is inside the declared scope (no warning). */
export async function cleanScopeFixture(
	cwd: string,
	taskId: string,
): Promise<void> {
	await gitInit(cwd);
	commitFile(cwd, 'src/a.ts');
	createPlanJson(cwd, taskId, ['src/a.ts']);
}

export function seedWriterSession(
	sessionId: string,
	taskId: string,
	files: string[],
): void {
	const session = ensureAgentSession(sessionId);
	advanceTaskState(session, taskId, 'coder_delegated');
	recordStageBCompletion(session, taskId, 'reviewer');
	recordStageBCompletion(session, taskId, 'test_engineer');
	recordModifiedFilesForTask(session, taskId, files);
}

export function seedCheckerSession(sessionId: string, taskId: string): void {
	const session = ensureAgentSession(sessionId);
	advanceTaskState(session, taskId, 'coder_delegated');
	recordStageBCompletion(session, taskId, 'reviewer');
	recordStageBCompletion(session, taskId, 'test_engineer');
}

/**
 * Seed the exact v1 review-route receipt contract for a checking session so
 * the reviewer gate's route leg (`routeGateAllowsTask`) passes legitimately —
 * no gate is disabled. Mirrors a routed reviewer/test_engineer delegation
 * pair: one MAC-authenticated persisted receipt bound to (session, task) via
 * the public writer, plus the matching in-memory Stage-B route evidence with
 * full dispatch bindings and the builder's deterministic default slots
 * (`<taskId>:<role>:<index>`). Same shape as
 * tests/unit/background/issue-2491-stage-b-route.test.ts.
 */
export async function seedReviewRouteContract(
	cwd: string,
	sessionId: string,
	taskId: string,
): Promise<void> {
	await persistReviewRouteReceipt({
		projectRoot: cwd,
		receipt: buildReviewRouteReceipt({
			sessionId,
			taskId,
			complexity: 'small',
			semanticRisk: 'low',
			requiredReviewers: ['route-reviewer-1'],
			requiredTestEngineers: ['route-test-engineer-1'],
		}),
	});
	const session = ensureAgentSession(sessionId);
	recordStageBRouteEvidence(session, taskId, {
		role: 'reviewer',
		identity: 'route-reviewer-1',
		sessionId,
		taskId,
		slotId: `${taskId}:reviewer:1`,
		callId: 'route-call-reviewer-1',
		childSessionId: 'route-child-reviewer-1',
		generation: 1,
	});
	recordStageBRouteEvidence(session, taskId, {
		role: 'test_engineer',
		identity: 'route-test-engineer-1',
		sessionId,
		taskId,
		slotId: `${taskId}:test_engineer:1`,
		callId: 'route-call-test-engineer-1',
		childSessionId: 'route-child-test-engineer-1',
		generation: 1,
	});
}

/**
 * Everything the two handler tests share on the success path: a clean-scope
 * repo + plan, a writer session holding the task's attribution record, and
 * the durable Stage B evidence chain (coder mutation → Stage A → reviewer +
 * test_engineer Stage B) that brings the exact-task workflow to tests_run
 * with every gate satisfied. Callers still seed the v1 review-route contract
 * for their own checking session (seedReviewRouteContract) — its session
 * binding differs per test.
 */
export async function seedHandlerSuccessFixture(
	cwd: string,
	taskId: string,
	writerSessionId: string,
): Promise<void> {
	await cleanScopeFixture(cwd, taskId);
	seedWriterSession(writerSessionId, taskId, [path.join(cwd, 'src', 'a.ts')]);
	// Durable Stage B evidence so the QA gate passes on status 'complete'
	// (same seeding shape as tests/unit/gate-evidence/workflow-transition).
	await transitionTaskWorkflowEvidence(cwd, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: 'mut-1',
	});
	await transitionTaskWorkflowEvidence(cwd, taskId, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: 'stage-a-1',
	});
	await transitionTaskWorkflowEvidence(cwd, taskId, {
		type: 'stage_b_completed',
		gate: 'reviewer',
		sessionId: 'rev-1',
		expectedGeneration: 1,
		transitionId: 'rev-1',
	});
	await transitionTaskWorkflowEvidence(cwd, taskId, {
		type: 'stage_b_completed',
		gate: 'test_engineer',
		sessionId: 'test-1',
		expectedGeneration: 1,
		transitionId: 'test-1',
	});
}

export const FOREIGN_ADVISORY =
	'exists under another session — not used for scope verification';
export const NO_RECORD_ADVISORY =
	'no attribution record in this session — not used for scope verification';
