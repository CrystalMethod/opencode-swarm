/**
 * Issue #2926 — attribution session-identity contract guardrail.
 *
 * The per-task attribution record (`AgentSessionState.modifiedFilesByTask`) is
 * session-private, but writers and the scope-warning reader key it by different
 * session ids. When the checking session differs from the recording session the
 * read came back empty and the SCOPE WARNING silently fell back to the
 * repository-wide git diff (#2818's cross-task mis-attribution, for that
 * subset). The contract chosen for #2926 (option 3, disclosure-first): the
 * fallback itself stays, but it is never silent — every in-session scoped
 * completion that did NOT use a per-task attribution record appends a
 * `SCOPE ADVISORY:` line to the gate reason disclosing why.
 *
 * This suite pins that contract end to end through the real
 * `checkReviewerGateWithScope`, with per-test swarm-state resets and unique
 * task ids (the probe matches on exact taskId; module-global state must not
 * leak between cases).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	advanceTaskState,
	ensureAgentSession,
	recordModifiedFilesForTask,
	recordStageBCompletion,
	resetSwarmState,
} from '../../../src/state';
import { checkReviewerGateWithScope } from '../../../src/tools/update-task-status';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir.js';

function mkTempDir(): string {
	return canonicalMkdtemp('attribution-contract-2926-');
}

function run(cmd: string[], cwd: string): number {
	const proc = Bun.spawnSync(cmd, { cwd, stdout: 'ignore', stderr: 'ignore' });
	return proc.exitCode ?? 0;
}

async function gitInit(cwd: string): Promise<void> {
	run(['git', 'init'], cwd);
	run(['git', 'config', 'user.email', 'test@test.com'], cwd);
	run(['git', 'config', 'user.name', 'Test'], cwd);
	fs.writeFileSync(path.join(cwd, 'dummy.txt'), 'initial');
	run(['git', 'add', '.'], cwd);
	run(['git', 'commit', '-m', 'initial'], cwd);
}

function commitFile(cwd: string, file: string): void {
	const fullPath = path.join(cwd, file);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, `content of ${file}`);
	run(['git', 'add', file], cwd);
	run(['git', 'commit', '-m', `add ${file}`], cwd);
}

function createPlanJson(cwd: string, taskId: string, scope: string[]): void {
	const plan = {
		phases: [
			{
				id: '1',
				name: 'Phase 1',
				tasks: [{ id: taskId, files_touched: scope }],
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
async function foreignCommitFixture(
	cwd: string,
	taskId: string,
): Promise<void> {
	await gitInit(cwd);
	commitFile(cwd, 'src/a.ts');
	commitFile(cwd, 'src/b.ts');
	createPlanJson(cwd, taskId, ['src/a.ts']);
}

/** Clean fixture: the repo-wide set is inside the declared scope (no warning). */
async function cleanScopeFixture(cwd: string, taskId: string): Promise<void> {
	await gitInit(cwd);
	commitFile(cwd, 'src/a.ts');
	createPlanJson(cwd, taskId, ['src/a.ts']);
}

function seedWriterSession(
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

function seedCheckerSession(sessionId: string, taskId: string): void {
	const session = ensureAgentSession(sessionId);
	advanceTaskState(session, taskId, 'coder_delegated');
	recordStageBCompletion(session, taskId, 'reviewer');
	recordStageBCompletion(session, taskId, 'test_engineer');
}

const FOREIGN_ADVISORY =
	'exists under another session — not used for scope verification';
const NO_RECORD_ADVISORY =
	'no attribution record in this session — not used for scope verification';

describe('attribution session-identity contract (#2926)', () => {
	let tmpDir: string | undefined;

	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		if (tmpDir) {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
			tmpDir = undefined;
		}
	});

	test('mismatch: foreign-session record is disclosed on the fallback warning', async () => {
		tmpDir = mkTempDir();
		const taskId = '2926-mismatch-1';
		await foreignCommitFixture(tmpDir, taskId);
		seedWriterSession('w-mismatch-1', taskId, [
			path.join(tmpDir, 'src', 'a.ts'),
		]);
		seedCheckerSession('c-mismatch-1', taskId);

		const result = await checkReviewerGateWithScope(
			taskId,
			tmpDir,
			'c-mismatch-1',
		);
		expect(result.reason ?? '').toContain('SCOPE ADVISORY');
		expect(result.reason ?? '').toContain(FOREIGN_ADVISORY);
		// The warning's evidence clause is unchanged (#2818 contract preserved).
		expect(result.reason ?? '').toContain(
			'(evidence: repository-wide diff vs latest commit',
		);
	});

	test('mismatch, no record anywhere: session-absence wording is disclosed', async () => {
		tmpDir = mkTempDir();
		const taskId = '2926-norecord-1';
		await foreignCommitFixture(tmpDir, taskId);
		seedCheckerSession('c-norecord-1', taskId);

		const result = await checkReviewerGateWithScope(
			taskId,
			tmpDir,
			'c-norecord-1',
		);
		expect(result.reason ?? '').toContain('SCOPE ADVISORY');
		expect(result.reason ?? '').toContain(NO_RECORD_ADVISORY);
		expect(result.reason ?? '').not.toContain(FOREIGN_ADVISORY);
	});

	test('clean repo-wide set + foreign record: advisory fires with no SCOPE WARNING', async () => {
		tmpDir = mkTempDir();
		const taskId = '2926-cleanset-1';
		await cleanScopeFixture(tmpDir, taskId);
		seedWriterSession('w-cleanset-1', taskId, [
			path.join(tmpDir, 'src', 'a.ts'),
		]);
		seedCheckerSession('c-cleanset-1', taskId);

		const result = await checkReviewerGateWithScope(
			taskId,
			tmpDir,
			'c-cleanset-1',
		);
		expect(result.reason ?? '').not.toContain('SCOPE WARNING');
		expect(result.reason ?? '').toContain('SCOPE ADVISORY');
		expect(result.reason ?? '').toContain(FOREIGN_ADVISORY);
	});

	test('writer-session leg (attribution honored): no advisory, no warning', async () => {
		tmpDir = mkTempDir();
		const taskId = '2926-writer-1';
		await foreignCommitFixture(tmpDir, taskId);
		seedWriterSession('w-writer-1', taskId, [path.join(tmpDir, 'src', 'a.ts')]);

		const result = await checkReviewerGateWithScope(
			taskId,
			tmpDir,
			'w-writer-1',
		);
		expect(result.reason ?? '').not.toContain('SCOPE WARNING');
		expect(result.reason ?? '').not.toContain('SCOPE ADVISORY');
	});

	test('empty-array foreign slot is not a hit (no-record wording)', async () => {
		tmpDir = mkTempDir();
		const taskId = '2926-empty-1';
		await foreignCommitFixture(tmpDir, taskId);
		seedWriterSession('w-empty-1', taskId, []);
		seedCheckerSession('c-empty-1', taskId);

		const result = await checkReviewerGateWithScope(
			taskId,
			tmpDir,
			'c-empty-1',
		);
		expect(result.reason ?? '').toContain(NO_RECORD_ADVISORY);
	});

	test('cross-project foreign record is not a hit when both keys are defined', async () => {
		tmpDir = mkTempDir();
		const taskId = '2926-xproj-1';
		await foreignCommitFixture(tmpDir, taskId);
		const writer = ensureAgentSession('w-xproj-1');
		writer.owningProjectKey = 'proj-other';
		recordModifiedFilesForTask(writer, taskId, [
			path.join(tmpDir, 'src', 'a.ts'),
		]);
		const checker = ensureAgentSession('c-xproj-1');
		checker.owningProjectKey = 'proj-here';

		const result = await checkReviewerGateWithScope(
			taskId,
			tmpDir,
			'c-xproj-1',
		);
		expect(result.reason ?? '').toContain(NO_RECORD_ADVISORY);
	});

	test('sessionID undefined: no advisory (CLI/direct path)', async () => {
		tmpDir = mkTempDir();
		const taskId = '2926-nosession-1';
		await foreignCommitFixture(tmpDir, taskId);

		const result = await checkReviewerGateWithScope(taskId, tmpDir, undefined);
		expect(result.reason ?? '').not.toContain('SCOPE ADVISORY');
	});

	test('task without declared scope: no advisory even with empty record', async () => {
		tmpDir = mkTempDir();
		const taskId = '2926-noscope-1';
		await gitInit(tmpDir);
		commitFile(tmpDir, 'src/b.ts');
		const plan = { phases: [{ id: '1', name: 'P', tasks: [{ id: taskId }] }] };
		fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
		seedCheckerSession('c-noscope-1', taskId);

		const result = await checkReviewerGateWithScope(
			taskId,
			tmpDir,
			'c-noscope-1',
		);
		expect(result.reason ?? '').not.toContain('SCOPE ADVISORY');
	});

	test('missing plan.json: no advisory with empty record', async () => {
		tmpDir = mkTempDir();
		const taskId = '2926-noplan-1';
		await gitInit(tmpDir);
		seedCheckerSession('c-noplan-1', taskId);

		const result = await checkReviewerGateWithScope(
			taskId,
			tmpDir,
			'c-noplan-1',
		);
		expect(result.reason ?? '').not.toContain('SCOPE ADVISORY');
	});

	test('malformed legacy entry before the hit: guard skips it, foreign wording survives', async () => {
		tmpDir = mkTempDir();
		const taskId = '2926-malformed-1';
		await foreignCommitFixture(tmpDir, taskId);
		// Insertion order is load-bearing: checker -> malformed -> hit. Without
		// the per-iteration Map guard the probe pass throws at the malformed
		// entry and the outer catch would mis-disclose a no-record wording.
		seedCheckerSession('c-malformed-1', taskId);
		const malformed = ensureAgentSession('w-malformed-legacy');
		(
			malformed as unknown as { modifiedFilesByTask: unknown }
		).modifiedFilesByTask = {
			legacy: ['stale'],
		};
		seedWriterSession('w-malformed-hit', taskId, [
			path.join(tmpDir, 'src', 'a.ts'),
		]);

		const result = await checkReviewerGateWithScope(
			taskId,
			tmpDir,
			'c-malformed-1',
		);
		expect(result.reason ?? '').toContain(FOREIGN_ADVISORY);
	});

	test('blocked parity: the advisory never flips the gate decision', async () => {
		tmpDir = mkTempDir();
		const taskId = '2926-parity-1';
		await foreignCommitFixture(tmpDir, taskId);
		seedWriterSession('w-parity-1', taskId, [path.join(tmpDir, 'src', 'a.ts')]);
		seedCheckerSession('c-parity-1', taskId);

		const withScope = await checkReviewerGateWithScope(
			taskId,
			tmpDir,
			'c-parity-1',
		);
		const bare = await checkReviewerGateWithScope(taskId, tmpDir, 'w-parity-1');
		expect(withScope.blocked).toBe(bare.blocked);
		expect(withScope.reason ?? '').toContain('SCOPE ADVISORY');
	});

	test('placement pin: disclosure survives evidence-clause stripping', async () => {
		tmpDir = mkTempDir();
		const taskId = '2926-placement-1';
		await foreignCommitFixture(tmpDir, taskId);
		seedWriterSession('w-placement-1', taskId, [
			path.join(tmpDir, 'src', 'a.ts'),
		]);
		seedCheckerSession('c-placement-1', taskId);

		const result = await checkReviewerGateWithScope(
			taskId,
			tmpDir,
			'c-placement-1',
		);
		const reason = result.reason ?? '';
		// Literally replicates the frozen c1 check's strip-then-match: a
		// disclosure hidden inside an `(evidence: ...)` parenthetical must NOT
		// satisfy this pin.
		const stripped = reason.replaceAll(/\(evidence:[^)]*\)/g, '');
		expect(
			/(attribution record|no attribution|different session)/i.test(stripped),
		).toBe(true);
		expect(stripped).toContain('SCOPE ADVISORY');
	});
});
