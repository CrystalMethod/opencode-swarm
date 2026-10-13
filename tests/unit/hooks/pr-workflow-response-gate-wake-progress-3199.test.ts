/**
 * Issue #3199 (plan-critic round 2, finding 1 — judgment on record): a
 * journal-only PR-review gate write is an UNPRODUCTIVE wake. The wake brake's
 * progress token hashes the durable `state.revision`
 * (workflowProgressSnapshot); before #3199 the observability journals rode
 * the revision-bumping write path, so a journaled rejection masqueraded as
 * workflow activity and reset the unproductive-wake counter. After #3199,
 * journal writes are non-transitioning appends and must leave the token
 * unchanged, while a real state-machine write must still count as progress.
 *
 * GREEN at base ONLY in the sense that the token mechanics are what they
 * are; the DISCRIMINATING direction is the journal leg — at base it FAILED
 * (the journal write moved the token), after the fix it passes. Pinned in
 * both directions per the critic's requirement.
 *
 * Seeding pattern: hand-written legacy gate-state JSON, matching
 * tests/unit/pr-review/journal-revision-cas-3199.test.ts.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
	recordPrReviewVerdictRejection,
} from '../../../src/hooks/pr-workflow-gate.js';
import { _internals } from '../../../src/hooks/pr-workflow-response-gate.js';
import { writeStateWhileLocked } from '../../../src/pr-review/persistence.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = '2026-10-13T00:00:00.000Z';
const tempDirs: string[] = [];

function freshProject(prefix: string): string {
	const directory = canonicalMkdtemp(`sw3199-${prefix}-`);
	tempDirs.push(directory);
	mkdirSync(join(directory, '.git'), { recursive: true });
	return directory;
}

function seedGateState(directory: string, session: string): void {
	const stateFile = join(
		directory,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(session)}.json`,
	);
	mkdirSync(dirname(stateFile), { recursive: true });
	writeFileSync(
		stateFile,
		JSON.stringify({
			schemaVersion: 1,
			revision: 0,
			sessionID: session,
			mode: 'PR_REVIEW',
			activatedAt: NOW,
			updatedAt: NOW,
		}),
		'utf8',
	);
}

afterEach(() => {
	closeAllProjectDbs();
	for (const directory of tempDirs.splice(0)) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Windows: the SQLite WAL may briefly hold the temp dir; best-effort.
		}
	}
});

test('a journal-only write leaves the wake-progress token unchanged; a real state write still counts as progress', async () => {
	const directory = freshProject('wake-progress');
	const session = 'session-3199-wake-progress';
	seedGateState(directory, session);

	const before = await readPrWorkflowGateState(directory, session);
	expect(before).not.toBeNull();
	const tokenBefore = _internals.workflowProgressSnapshot(
		directory,
		session,
		before!,
	);
	expect(tokenBefore.kind).toBe('valid');

	// Leg 1 — journal-only write (the #3199 fix makes it non-transitioning):
	// the token must NOT change, so the wake brake correctly counts the next
	// wake as unproductive. At base this FAILED (the journal write bumped the
	// revision inside the token).
	await recordPrReviewVerdictRejection(
		directory,
		session,
		'3199 journal write is not wake progress',
	);
	const afterJournal = await readPrWorkflowGateState(directory, session);
	const tokenAfterJournal = _internals.workflowProgressSnapshot(
		directory,
		session,
		afterJournal!,
	);
	expect(tokenAfterJournal.kind).toBe('valid');
	expect(tokenAfterJournal.token).toBe(tokenBefore.token);

	// Leg 2 — a real state-machine write (revision bump): the token must
	// change, so genuine controller activity still resets the brake.
	const fresh = await readPrWorkflowGateState(directory, session);
	await writeStateWhileLocked(directory, { ...fresh!, updatedAt: NOW });
	const afterReal = await readPrWorkflowGateState(directory, session);
	const tokenAfterReal = _internals.workflowProgressSnapshot(
		directory,
		session,
		afterReal!,
	);
	expect(tokenAfterReal.kind).toBe('valid');
	expect(tokenAfterReal.token).not.toBe(tokenBefore.token);
});
