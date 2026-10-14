/**
 * Issue #3199 acceptance check C9 (plan-critic round 2, finding 1): the
 * durable-observability preservation on the state-machine write path must
 * cover EVERY observability field, not only the verdict journal. For the
 * submit journal (`prReviewSubmitRejections`, parent gate state via
 * delegation) and the advisory journal (`skillContractAdvisories`), a
 * stale-snapshot state write that lands after an observability append must
 * succeed (no revision CAS trip — that is C1/C2's fix) AND must not clobber
 * the appended entries (the preservation merge's per-field coverage).
 *
 * RED at base: the stale write throws `BLOCKED: ... changed concurrently`
 * (the append bumped the revision). GREEN after the fix only when the merge
 * registry covers BOTH fields — omitting either one fails this check's
 * survival assertions, which is exactly what the critic required.
 *
 * Seeding pattern: hand-written legacy gate-state JSON, matching
 * tests/unit/pr-review/journal-revision-cas-3199.test.ts.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { recordPendingDelegationDetailed } from '../../../src/background/pending-delegations.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	appendPrWorkflowSkillContractAdvisories,
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
	recordPrReviewSubmitRejection,
} from '../../../src/hooks/pr-workflow-gate.js';
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
		callID: 'call-3199-c9',
		normalizedAgent: 'swarm_explorer',
		swarmPrefixedAgent: 'swarm_explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'batch-3199-c9',
		laneId: 'lane-3199-c9',
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

test('submit-journal and advisory entries survive a stale-snapshot state write (per-field merge coverage)', async () => {
	// Leg 1 — submit journal on the parent's gate state.
	const submitDir = freshProject('submit-merge');
	const parent = 'session-3199-submit-merge';
	const child = 'child-3199-submit-merge';
	await seedSubmitDelegation(submitDir, parent, child);
	seedGateState(submitDir, parent);
	const submitSnapshot = await readPrWorkflowGateState(submitDir, parent);
	expect(submitSnapshot).not.toBeNull();
	await recordPrReviewSubmitRejection(
		submitDir,
		child,
		'3199 submit journal survives the stale-snapshot write',
	);
	let submitThrown: unknown = null;
	try {
		await writeStateWhileLocked(submitDir, {
			...submitSnapshot!,
			updatedAt: NOW,
		});
	} catch (error) {
		submitThrown = error;
	}
	// RED at base: the journal write bumped the revision and the stale write
	// threw BLOCKED. GREEN after the fix: the write lands AND the entry
	// survives only when the preservation merge covers prReviewSubmitRejections.
	expect(submitThrown).toBeNull();
	const postSubmit = await readPrWorkflowGateState(submitDir, parent);
	expect(postSubmit?.revision).toBe(submitSnapshot!.revision + 1);
	expect(
		postSubmit?.prReviewSubmitRejections?.some((entry) =>
			entry.message.includes('survives the stale-snapshot write'),
		),
	).toBe(true);

	// Leg 2 — advisory journal.
	const advisoryDir = freshProject('advisory-merge');
	const session = 'session-3199-advisory-merge';
	seedGateState(advisoryDir, session);
	const advisorySnapshot = await readPrWorkflowGateState(advisoryDir, session);
	expect(advisorySnapshot).not.toBeNull();
	await appendPrWorkflowSkillContractAdvisories(advisoryDir, session, [
		'3199 advisory survives the stale-snapshot write',
	]);
	let advisoryThrown: unknown = null;
	try {
		await writeStateWhileLocked(advisoryDir, {
			...advisorySnapshot!,
			updatedAt: NOW,
		});
	} catch (error) {
		advisoryThrown = error;
	}
	expect(advisoryThrown).toBeNull();
	const postAdvisory = await readPrWorkflowGateState(advisoryDir, session);
	expect(postAdvisory?.revision).toBe(advisorySnapshot!.revision + 1);
	expect(postAdvisory?.skillContractAdvisories).toContain(
		'3199 advisory survives the stale-snapshot write',
	);
});
