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
 * leak between cases). The SUCCESS-path handler wiring (F-001,
 * `executeUpdateTaskStatus` warnings) lives in the sibling
 * attribution-session-contract-2926.handler.test.ts; shared fixtures live in
 * _attribution-contract-2926-helpers.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	advanceTaskState,
	ensureAgentSession,
	getModifiedFilesForTask,
	hasModifiedFilesForTask,
	recordModifiedFilesForTask,
	recordStageBCompletion,
	resetModifiedFilesForTask,
	resetSwarmState,
} from '../../../src/state';
import {
	checkReviewerGate,
	checkReviewerGateWithScope,
} from '../../../src/tools/update-task-status';
import {
	cleanScopeFixture,
	commitFile,
	FOREIGN_ADVISORY,
	foreignCommitFixture,
	gitInit,
	mkTempDir,
	NO_RECORD_ADVISORY,
	seedCheckerSession,
	seedWriterSession,
} from './_attribution-contract-2926-helpers.js';

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

	test('keyless checker cannot claim a keyed foreign record (F-003)', async () => {
		tmpDir = mkTempDir();
		const taskId = '2926-keyless-1';
		await foreignCommitFixture(tmpDir, taskId);
		const writer = ensureAgentSession('w-keyless-1');
		writer.owningProjectKey = 'proj-other';
		recordModifiedFilesForTask(writer, taskId, [
			path.join(tmpDir, 'src', 'a.ts'),
		]);
		seedCheckerSession('c-keyless-1', taskId); // no owningProjectKey

		const result = await checkReviewerGateWithScope(
			taskId,
			tmpDir,
			'c-keyless-1',
		);
		expect(result.reason ?? '').toContain(NO_RECORD_ADVISORY);
		expect(result.reason ?? '').not.toContain(FOREIGN_ADVISORY);
	});

	test('present-but-empty checking-session record is NOT a degraded fallback (F-002/F-005)', async () => {
		tmpDir = mkTempDir();
		const taskId = '2926-emptylocal-1';
		await foreignCommitFixture(tmpDir, taskId);
		// The delegation flow leaves a present-but-empty slot in the checking
		// session itself (resetModifiedFilesForTask without remove): the task's
		// own record exists and is legitimately empty, so the "no attribution
		// record in this session" wording would be literally false. No advisory.
		const checker = ensureAgentSession('c-emptylocal-1');
		advanceTaskState(checker, taskId, 'coder_delegated');
		recordStageBCompletion(checker, taskId, 'reviewer');
		recordStageBCompletion(checker, taskId, 'test_engineer');
		expect(resetModifiedFilesForTask(checker, taskId)).toBe(true);
		expect(hasModifiedFilesForTask(checker, taskId)).toBe(true);
		expect(getModifiedFilesForTask(checker, taskId)).toEqual([]);

		const result = await checkReviewerGateWithScope(
			taskId,
			tmpDir,
			'c-emptylocal-1',
		);
		expect(result.reason ?? '').not.toContain('SCOPE ADVISORY');
		// The repo-wide fallback still runs for the zero-file record — the
		// ordinary SCOPE WARNING (with its evidence clause) is unchanged.
		expect(result.reason ?? '').toContain('SCOPE WARNING');
		expect(result.reason ?? '').toContain(
			'(evidence: repository-wide diff vs latest commit',
		);
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

	test('blocked parity: wrapper matches the plain gate on the same fixture (F-006)', async () => {
		tmpDir = mkTempDir();
		const taskId = '2926-parity-1';
		await foreignCommitFixture(tmpDir, taskId);
		seedWriterSession('w-parity-1', taskId, [path.join(tmpDir, 'src', 'a.ts')]);
		seedCheckerSession('c-parity-1', taskId);

		// Compare against the PLAIN sync gate on the same fixture and session —
		// not two wrapper calls — so the assertion is a real cross-path parity
		// anchor rather than two fixtures that are blocked for the same reason.
		const withScope = await checkReviewerGateWithScope(
			taskId,
			tmpDir,
			'c-parity-1',
		);
		const plain = checkReviewerGate(taskId, tmpDir, true, 'c-parity-1');
		expect(withScope.blocked).toBe(plain.blocked);
		expect(withScope.reason ?? '').toContain('SCOPE ADVISORY');
		expect(plain.reason ?? '').not.toContain('SCOPE ADVISORY');
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
