/**
 * Issue #3199 acceptance checks (issue-tracer Phase 2.5 — frozen check file).
 *
 * The PR-review rejection journals (`prReviewVerdictRejections`, written by
 * `recordPrReviewVerdictRejection`, and `prReviewSubmitRejections`, written by
 * `recordPrReviewSubmitRejection`) are observability-only data riding inside
 * the PR-review gate state. No settlement decision reads them, so they must
 * not perturb the durable state `revision` that the write CAS compares:
 * gate operations that read state outside the session lock and write/compare
 * later (e.g. `completePrWorkflow`) otherwise fail with spurious
 * `BLOCKED: ... state changed concurrently` errors when only a journal write
 * intervened.
 *
 * Frozen acceptance checks:
 *   AC1 — a journal write (both journals) leaves the durable revision
 *         unchanged while the entry persists durably. RED at base, GREEN
 *         after the fix.
 *   AC2 — a journal write inside another operation's read-check-write window
 *         does not trip that operation's revision CAS, the operation's write
 *         still lands as revision+1, and the journaled entry survives (no
 *         silent journal loss). RED at base, GREEN after the fix.
 *   AC3 — journal entries survive a concurrent state write issued from a
 *         fresh read. GREEN at base, must stay GREEN after the fix.
 *   AC5 — a REAL durable state mutation (full CAS write path) still trips the
 *         revision CAS for a stale snapshot. GREEN at base, must stay GREEN
 *         after the fix — guards against over-broad fixes that weaken the
 *         CAS.
 *
 * Seeding pattern: hand-written legacy gate-state JSON (imported into the
 * SQLite coordination row on the first read), matching
 * tests/unit/tools/collect-lanes-submit-rejection-visibility-2859.test.ts.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { recordPendingDelegationDetailed } from '../../../src/background/pending-delegations.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
	recordPrReviewSubmitRejection,
	recordPrReviewVerdictRejection,
} from '../../../src/hooks/pr-workflow-gate.js';
import { writeStateWhileLocked } from '../../../src/pr-review/persistence.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/** Fixed instant for all seeded/mutated timestamps — no raw clock reads. */
const NOW = '2026-10-13T00:00:00.000Z';

/** Temp dirs created by the current test; drained best-effort in afterEach. */
const tempDirs: string[] = [];

/** Fresh project root: canonical temp dir plus the `.git` marker the
 * delegation ledger writer asserts before recording (project-root check). */
function freshProject(prefix: string): string {
	const directory = canonicalMkdtemp(`sw3199-${prefix}-`);
	tempDirs.push(directory);
	mkdirSync(join(directory, '.git'), { recursive: true });
	return directory;
}

/** Hand-written legacy gate state at revision 0. The persistence layer
 * derives the filename from a session stem (`<sessionID>-<hash>.json`), not
 * the raw session id, and imports this JSON into the SQLite coordination row
 * on the first read — the exact pattern of the #2859 visibility test. */
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

/** Seed one `swarm-pr-review:base` delegation so the submit journal can hop
 * from the child session to the parent gate-owner session. */
async function seedSubmitDelegation(
	directory: string,
	parent: string,
	child: string,
): Promise<void> {
	const outcome = await recordPendingDelegationDetailed(directory, {
		correlationId: child,
		jobId: null,
		subagentSessionId: child,
		parentSessionId: parent,
		callID: 'call-3199',
		normalizedAgent: 'swarm_explorer',
		swarmPrefixedAgent: 'swarm_explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'batch-3199',
		laneId: 'lane-3199',
		mode: 'swarm-pr-review:base',
		workflowLane: 'correctness-state',
		prReviewLegacyTranscriptCompatibility: false,
		promptHash: null,
		workspace: {
			directory,
			gitHead: 'head-3199',
			dirtyHash: null,
			prHeadSha: 'head-3199',
			scope: 'complete PR diff base-3199...head-3199',
		},
	});
	if (outcome.status !== 'recorded') {
		throw new Error(`delegation seed failed: ${outcome.status}`);
	}
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

// ---------------------------------------------------------------------------
// AC1 (discriminating): journals must not advance the durable revision.
// ---------------------------------------------------------------------------

test('a journal write does not advance the durable gate revision (both journals)', async () => {
	// Verdict journal — the caller's own gate state.
	const verdictDir = freshProject('verdict-rev');
	const verdictSession = 'session-3199-verdict-rev';
	seedGateState(verdictDir, verdictSession);
	const beforeVerdict = await readPrWorkflowGateState(
		verdictDir,
		verdictSession,
	);
	expect(beforeVerdict).not.toBeNull();
	await recordPrReviewVerdictRejection(
		verdictDir,
		verdictSession,
		'3199 verdict journal must not bump the revision',
	);
	const afterVerdict = await readPrWorkflowGateState(
		verdictDir,
		verdictSession,
	);
	// RED at base (journal write bumps 0 -> 1); GREEN after the fix.
	expect(afterVerdict?.revision).toBe(beforeVerdict?.revision);
	// The entry itself must persist durably (disk-authoritative read).
	expect(
		afterVerdict?.prReviewVerdictRejections?.some((entry) =>
			entry.message.includes('must not bump the revision'),
		),
	).toBe(true);

	// Submit journal — the parent's gate state via delegation lookup.
	const submitDir = freshProject('submit-rev');
	const submitSession = 'session-3199-submit-rev';
	const submitChild = 'child-3199-submit-rev';
	await seedSubmitDelegation(submitDir, submitSession, submitChild);
	seedGateState(submitDir, submitSession);
	const beforeSubmit = await readPrWorkflowGateState(submitDir, submitSession);
	expect(beforeSubmit).not.toBeNull();
	await recordPrReviewSubmitRejection(
		submitDir,
		submitChild,
		'3199 submit journal must not bump the revision',
	);
	const afterSubmit = await readPrWorkflowGateState(submitDir, submitSession);
	// RED at base (journal write bumps 0 -> 1); GREEN after the fix.
	expect(afterSubmit?.revision).toBe(beforeSubmit?.revision);
	expect(
		afterSubmit?.prReviewSubmitRejections?.some((entry) =>
			entry.message.includes('must not bump the revision'),
		),
	).toBe(true);
});

// ---------------------------------------------------------------------------
// AC2 (discriminating): a journal write must not trip a concurrent
// operation's revision CAS.
// ---------------------------------------------------------------------------

test("a journal write inside a concurrent operation's read-check-write window does not trip its revision CAS", async () => {
	const directory = freshProject('verdict-cas');
	const session = 'session-3199-verdict-cas';
	seedGateState(directory, session);
	// The concurrent operation's read: its stale snapshot at revision N.
	const snapshot = await readPrWorkflowGateState(directory, session);
	expect(snapshot).not.toBeNull();

	// The journal write lands inside the operation's read-check-write window.
	await recordPrReviewVerdictRejection(
		directory,
		session,
		'3199 journal inside the CAS window',
	);

	// The operation's write with its captured snapshot must succeed.
	// RED at base: throws `BLOCKED: PR workflow gate state changed
	// concurrently`; GREEN after the fix.
	let thrown: unknown = null;
	try {
		await writeStateWhileLocked(directory, {
			...snapshot!,
			updatedAt: NOW,
		});
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeNull();

	// CAS semantics are preserved: the operation's write lands as N+1.
	const post = await readPrWorkflowGateState(directory, session);
	expect(post?.revision).toBe(snapshot!.revision + 1);
	// No silent journal loss: the journaled entry is still readable afterwards.
	expect(
		post?.prReviewVerdictRejections?.some((entry) =>
			entry.message.includes('inside the CAS window'),
		),
	).toBe(true);
});

// ---------------------------------------------------------------------------
// AC3 (preserving): journal entries survive a concurrent fresh-read write.
// ---------------------------------------------------------------------------

test('journal entries survive a concurrent state write from a fresh read', async () => {
	// Verdict journal.
	const verdictDir = freshProject('verdict-preserve');
	const verdictSession = 'session-3199-verdict-preserve';
	seedGateState(verdictDir, verdictSession);
	await recordPrReviewVerdictRejection(
		verdictDir,
		verdictSession,
		'3199 verdict preserved across a fresh-read write',
	);
	const freshVerdict = await readPrWorkflowGateState(
		verdictDir,
		verdictSession,
	);
	expect(
		freshVerdict?.prReviewVerdictRejections?.length ?? 0,
	).toBeGreaterThanOrEqual(1);
	// A concurrent operation that re-read before writing must keep the entry.
	await writeStateWhileLocked(verdictDir, {
		...freshVerdict!,
		updatedAt: NOW,
	});
	const postVerdict = await readPrWorkflowGateState(verdictDir, verdictSession);
	expect(postVerdict?.revision).toBe(freshVerdict!.revision + 1);
	expect(
		postVerdict?.prReviewVerdictRejections?.some((entry) =>
			entry.message.includes('verdict preserved across'),
		),
	).toBe(true);

	// Submit journal (parent state via delegation lookup).
	const submitDir = freshProject('submit-preserve');
	const submitSession = 'session-3199-submit-preserve';
	const submitChild = 'child-3199-submit-preserve';
	await seedSubmitDelegation(submitDir, submitSession, submitChild);
	seedGateState(submitDir, submitSession);
	await recordPrReviewSubmitRejection(
		submitDir,
		submitChild,
		'3199 submit preserved across a fresh-read write',
	);
	const freshSubmit = await readPrWorkflowGateState(submitDir, submitSession);
	expect(
		freshSubmit?.prReviewSubmitRejections?.length ?? 0,
	).toBeGreaterThanOrEqual(1);
	await writeStateWhileLocked(submitDir, {
		...freshSubmit!,
		updatedAt: NOW,
	});
	const postSubmit = await readPrWorkflowGateState(submitDir, submitSession);
	expect(postSubmit?.revision).toBe(freshSubmit!.revision + 1);
	expect(
		postSubmit?.prReviewSubmitRejections?.some((entry) =>
			entry.message.includes('submit preserved across'),
		),
	).toBe(true);
});

// ---------------------------------------------------------------------------
// AC5 (preserving): real state mutations still trip the revision CAS.
// ---------------------------------------------------------------------------

test('a real state mutation still trips the revision CAS', async () => {
	const directory = freshProject('real-cas');
	const session = 'session-3199-real-cas';
	seedGateState(directory, session);
	// The concurrent operation's stale snapshot at revision N.
	const stale = await readPrWorkflowGateState(directory, session);
	expect(stale).not.toBeNull();

	// A REAL durable state mutation: a fresh read then the full CAS write
	// path — bumps the durable revision N -> N+1.
	const fresh = await readPrWorkflowGateState(directory, session);
	await writeStateWhileLocked(directory, {
		...fresh!,
		updatedAt: NOW,
	});

	// The stale-snapshot write must still be refused. GREEN at base and after
	// the fix — a change that lets this through has weakened the CAS.
	let thrown: unknown = null;
	try {
		await writeStateWhileLocked(directory, {
			...stale!,
			updatedAt: NOW,
		});
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(Error);
	expect((thrown as Error).message).toContain('BLOCKED');
	expect((thrown as Error).message).toContain('changed concurrently');
});
