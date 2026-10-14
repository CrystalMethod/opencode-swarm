/**
 * Issue #3199 acceptance check C8 (end-to-end victim window — the terminal
 * clear path, not the generic write CAS). `clearPrWorkflowGateState`
 * compares its caller-supplied `expectedRevision` against the durable
 * revision and throws `BLOCKED: PR workflow gate state changed during
 * terminal completion` on mismatch — exactly the class of spurious failure a
 * journal write could induce inside `completePrWorkflow`'s read-check-write
 * window. After the fix, a journal-only write no longer moves the revision,
 * so a terminal clear armed with the pre-journal revision succeeds.
 *
 * RED at base (the journal write bumps the revision and the clear throws),
 * GREEN after the fix.
 *
 * Seeding pattern: hand-written legacy gate-state JSON, matching
 * tests/unit/pr-review/journal-revision-cas-3199.test.ts.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	clearPrWorkflowGateState,
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
	recordPrReviewVerdictRejection,
} from '../../../src/hooks/pr-workflow-gate.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = '2026-10-13T00:00:00.000Z';
const tempDirs: string[] = [];

test("a journal write inside the terminal-clear window does not trip the clear's revision compare", async () => {
	const directory = canonicalMkdtemp('sw3199-clear-cas-');
	tempDirs.push(directory);
	mkdirSync(join(directory, '.git'), { recursive: true });
	const session = 'session-3199-clear-cas';
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

	// The concurrent terminal operation's read: the revision it will pass to
	// the clear as its CAS guard.
	const snapshot = await readPrWorkflowGateState(directory, session);
	expect(snapshot).not.toBeNull();

	// A journal write lands inside the operation's read-check-write window.
	await recordPrReviewVerdictRejection(
		directory,
		session,
		'3199 journal inside the terminal-clear window',
	);

	// The terminal clear armed with the pre-journal revision must succeed.
	// RED at base: throws `BLOCKED: PR workflow gate state changed during
	// terminal completion`; GREEN after the fix.
	let thrown: unknown = null;
	try {
		await clearPrWorkflowGateState(directory, session, snapshot!.revision);
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeNull();
	// The gate state is genuinely gone (the clear took effect).
	expect(await readPrWorkflowGateState(directory, session)).toBeNull();

	closeAllProjectDbs();
	try {
		rmSync(directory, { recursive: true, force: true });
	} catch {
		// Windows: best-effort temp teardown only.
	}
});

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
