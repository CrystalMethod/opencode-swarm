import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordPendingDelegationDetailed } from '../../../src/background/pending-delegations.js';
import {
	latestPrReviewSubmitRejectionMessage,
	MAX_PR_REVIEW_SUBMIT_REJECTIONS,
	validatePrReviewDiscoveryLaneCompletion,
} from '../../../src/hooks/pr-workflow-gate.js';
import { workflowGateStateRelativePath } from '../../../src/pr-review/persistence.js';
import { executeSubmitPrReviewResult } from '../../../src/tools/submit-pr-review-result.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #2859 (F3): rejected `submit_pr_review_result` attempts are journalled
 * on the parent PR_REVIEW gate state and surfaced in the discovery
 * contract-failure message, so the orchestrator can see WHY a lane ended
 * without a receipt instead of learning it from lane prose. Journaling is
 * fail-open observability: it never changes the rejection outcome, never
 * creates gate state (or even a lock file) for a parent that has none, and is
 * FIFO-bounded.
 */

const CHILD = 'child-2859';
const PARENT = 'parent-2859';
const NOW = '2026-09-19T00:00:00.000Z';

function statePath(directory: string): string {
	// The persistence layer derives the state filename from a session stem
	// (`<sessionID>-<hash>.json`), not the raw session id.
	return join(directory, '.swarm', workflowGateStateRelativePath(PARENT));
}

function writeGateState(directory: string): void {
	const stateFile = statePath(directory);
	mkdirSync(join(stateFile, '..'), { recursive: true });
	writeFileSync(
		stateFile,
		JSON.stringify({
			schemaVersion: 1,
			revision: 0,
			sessionID: PARENT,
			mode: 'PR_REVIEW',
			activatedAt: NOW,
			updatedAt: NOW,
		}),
		'utf8',
	);
}

function readJournal(
	directory: string,
): Array<{ childSessionId: string; message: string }> {
	const state = JSON.parse(readFileSync(statePath(directory), 'utf8')) as {
		prReviewSubmitRejections?: Array<{
			childSessionId: string;
			message: string;
		}>;
	};
	return state.prReviewSubmitRejections ?? [];
}

async function writePendingDelegation(directory: string): Promise<void> {
	// .git marker: the evidence lock behind the ledger writer asserts a
	// project root (see tests/unit/hooks/pr-workflow-gate.test-fixtures.ts).
	mkdirSync(join(directory, '.git'), { recursive: true });
	const outcome = await recordPendingDelegationDetailed(directory, {
		correlationId: CHILD,
		jobId: null,
		subagentSessionId: CHILD,
		parentSessionId: PARENT,
		callID: 'call-2859',
		normalizedAgent: 'swarm_explorer',
		swarmPrefixedAgent: 'swarm_explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'batch-2859',
		laneId: 'lane-2859',
		mode: 'swarm-pr-review:base',
		workflowLane: 'correctness-state',
		prReviewLegacyTranscriptCompatibility: false,
		promptHash: null,
		workspace: {
			directory,
			gitHead: 'head-1',
			dirtyHash: null,
			prHeadSha: 'head-1',
			scope: 'complete PR diff base-1...head-1',
		},
	});
	// The writer fail-opens to { status: 'failed' } on bad input; assert it.
	expect(outcome.status).toBe('recorded');
}

function invalidSubmitArgs(): Record<string, unknown> {
	return {
		schemaVersion: '2',
		revisionDigest: 'd'.repeat(64),
		result: { schemaVersion: 1 },
	};
}

describe('recordPrReviewSubmitRejection via the tool layer (issue #2859 F3)', () => {
	test('a schema-rejected submit journals its enriched message on the parent gate state', async () => {
		const directory = canonicalMkdtemp('sw2859-f3a-');
		await writePendingDelegation(directory);
		writeGateState(directory);

		const raw = await executeSubmitPrReviewResult(
			invalidSubmitArgs(),
			directory,
			{
				sessionID: CHILD,
			},
		);
		const outcome = JSON.parse(raw) as { success: boolean; message: string };
		expect(outcome.success).toBeFalse();
		expect(outcome.message).toContain('Invalid PR-review result');

		const journal = readJournal(directory);
		expect(journal).toHaveLength(1);
		expect(journal[0].childSessionId).toBe(CHILD);
		expect(journal[0].message).toContain('Invalid PR-review result');
		expect(journal[0].message).toContain('received "2" (string)');
		expect(journal[0].message.length).toBeLessThanOrEqual(300);
	});

	test('identical consecutive rejection messages are deduped in the journal (PRR-015)', async () => {
		const directory = canonicalMkdtemp('sw2859-f3f-');
		await writePendingDelegation(directory);
		writeGateState(directory);

		const args = {
			schemaVersion: '2',
			revisionDigest: 'd'.repeat(64),
			result: { schemaVersion: 1 },
		};
		// First rejection: journaled.
		await executeSubmitPrReviewResult(args, directory, { sessionID: CHILD });
		expect(readJournal(directory)).toHaveLength(1);
		// Second IDENTICAL rejection: byte-identical message → deduped (a
		// hostile retry loop cannot amplify gate-state writes).
		await executeSubmitPrReviewResult(args, directory, { sessionID: CHILD });
		expect(readJournal(directory)).toHaveLength(1);
		// A DIFFERENT rejection (a distinct offending field whose issue text
		// differs within the 300-char journal window) appends a new entry —
		// observability is preserved for genuinely new information. Note a
		// new VALID digest ('e'.repeat(64)) would not count as different: the
		// digest issue disappears and the difference falls outside the
		// 300-char bound, so dedup correctly suppresses it.
		await executeSubmitPrReviewResult(
			{ ...args, revisionDigest: 'ZZZ' },
			directory,
			{ sessionID: CHILD },
		);
		const journal = readJournal(directory);
		expect(journal).toHaveLength(2);
		expect(journal[0].message).not.toBe(journal[1].message);
	});

	test('a URL-credential-bearing rejection message is redacted in the journal (PRR-002)', async () => {
		const directory = canonicalMkdtemp('sw2859-f3e-');
		await writePendingDelegation(directory);
		writeGateState(directory);

		// The child embeds a credential-bearing URL in the offending field;
		// the journal must persist the redacted form (boundPublicationDiagnostic
		// precedent), never the raw secret.
		const raw = await executeSubmitPrReviewResult(
			{
				schemaVersion: 1,
				revisionDigest: 'https://user:supertoken@host.example.com/x',
				result: { schemaVersion: 1 },
			},
			directory,
			{ sessionID: CHILD },
		);
		const outcome = JSON.parse(raw) as { success: boolean; message: string };
		expect(outcome.success).toBeFalse();
		expect(outcome.message).toContain('supertoken');

		const journal = readJournal(directory);
		expect(journal).toHaveLength(1);
		expect(journal[0].message).not.toContain('supertoken');
		expect(journal[0].message).toContain('[REDACTED:url_credentials]@');
	});

	test('no gate state (and no lock file) is created when the parent never opened a gate', async () => {
		const directory = canonicalMkdtemp('sw2859-f3b-');
		await writePendingDelegation(directory);
		// No gate state file on purpose.

		const raw = await executeSubmitPrReviewResult(
			invalidSubmitArgs(),
			directory,
			{
				sessionID: CHILD,
			},
		);
		const outcome = JSON.parse(raw) as { success: boolean; message: string };
		expect(outcome.success).toBeFalse();

		const gateDir = join(directory, '.swarm', 'pr-workflow-gates');
		expect(existsSync(gateDir)).toBeFalse();
	});

	test('a missing delegation record is a no-op (nothing to attribute)', async () => {
		const directory = canonicalMkdtemp('sw2859-f3c-');
		writeGateState(directory);

		const raw = await executeSubmitPrReviewResult(
			invalidSubmitArgs(),
			directory,
			{
				sessionID: 'unknown-child-2859',
			},
		);
		expect(JSON.parse(raw).success).toBeFalse();
		expect(readJournal(directory)).toEqual([]);
	});
});

describe('gate-layer rejection wrap point (issue #2859 F3)', () => {
	test('a gate-layer rejection (batch/lane identity mismatch) is journalled too', async () => {
		const directory = canonicalMkdtemp('sw2859-f3d-');
		await writePendingDelegation(directory);
		writeGateState(directory);

		const raw = await executeSubmitPrReviewResult(
			{
				schemaVersion: 1,
				batchId: 'batch-2859',
				laneId: 'WRONG-lane',
				revisionDigest: 'd'.repeat(64),
				result: {
					schemaVersion: 1,
					outcome: 'CLEAN',
					creditedLanes: ['intent-architecture'],
					findings: [],
					cleanAttestations: [
						{
							workflowLane: 'intent-architecture',
							coverageScope:
								'Reviewed the complete changed architecture surface.',
							evidence:
								'No reachable architecture defect remains in the bound diff.',
						},
					],
					unresolved: [],
				},
			},
			directory,
			{ sessionID: CHILD },
		);
		const outcome = JSON.parse(raw) as { success: boolean; reason?: string };
		expect(outcome.success).toBeFalse();
		// Wrap-point coverage rationale: this exercises the single wrap over
		// submitPrReviewResultCore; every other gate-layer rejection reason
		// (envelope, store, selection, binding, revision, reducer, publisher)
		// returns through the same wrap by construction.
		expect(outcome.reason).toContain('identity mismatch');

		const journal = readJournal(directory);
		expect(journal).toHaveLength(1);
		expect(journal[0].message).toContain('identity mismatch');
	});
});

describe('latestPrReviewSubmitRejectionMessage (issue #2859 F3)', () => {
	test('newest entry for the child session wins', () => {
		const state = {
			prReviewSubmitRejections: [
				{ childSessionId: 'other', message: 'first' },
				{ childSessionId: CHILD, message: 'earlier' },
				{ childSessionId: CHILD, message: 'latest' },
			],
		};
		expect(latestPrReviewSubmitRejectionMessage(state, CHILD)).toBe('latest');
		expect(
			latestPrReviewSubmitRejectionMessage(
				{ prReviewSubmitRejections: undefined },
				CHILD,
			),
		).toBeUndefined();
	});
});

describe('discovery contract-failure surfacing (issue #2859 F3)', () => {
	// Fixture mirrors the FB-007 legacy-disabled branch shape from
	// pr-workflow-gate-structured-receipts.test.ts.
	function baseInput() {
		return {
			record: {
				schemaVersion: 4,
				correlationId: CHILD,
				jobId: null,
				subagentSessionId: CHILD,
				parentSessionId: PARENT,
				callID: 'call-2859',
				normalizedAgent: 'explorer',
				swarmPrefixedAgent: 'explorer',
				planTaskId: null,
				evidenceTaskId: null,
				status: 'completed',
				createdAt: 2_000,
				updatedAt: 2_000,
				batchId: 'batch-2859',
				laneId: 'lane-2859',
				mode: 'swarm-pr-review:base',
				workflowLane: 'correctness-state',
				workspace: {
					directory: '/project',
					gitHead: 'head-1',
					dirtyHash: null,
					prHeadSha: 'head-1',
					scope: 'complete PR diff base-1...head-1',
				},
			},
			result: {
				text: 'ordinary prose without a structured receipt',
				chars: 41,
				truncated: false,
				digest: 'a'.repeat(64),
				outputRef: `L1:${'b'.repeat(64)}:${'c'.repeat(64)}:${'a'.repeat(64)}`,
			},
			artifact: null,
			expected: {
				mode: 'swarm-pr-review:base' as const,
				workflowLane: 'correctness-state',
				prHeadSha: 'head-1',
				gitHead: 'head-1',
				revisionDigest: 'revision-1',
				workflowInstanceId: 'workflow-1',
				workflowRevision: 1,
				baseSha: 'base-1',
				reviewScope: 'complete PR diff base-1...head-1',
			},
		};
	}

	test('the failure message carries the journaled rejection when provided', () => {
		const result = validatePrReviewDiscoveryLaneCompletion({
			...baseInput(),
			lastSubmitRejection:
				'Invalid PR-review result: schemaVersion: Invalid input: expected 1 (received "1" (string))',
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected failure');
		expect(result.failure.actual).toContain(
			'missing structured receipt (legacy transcript adapter disabled)',
		);
		expect(result.failure.actual).toContain(
			'; last rejected submit_pr_review_result: Invalid PR-review result: schemaVersion: Invalid input: expected 1 (received "1" (string))',
		);
	});

	test('the failure message keeps its original form without a journal entry', () => {
		const result = validatePrReviewDiscoveryLaneCompletion(baseInput());
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected failure');
		expect(result.failure.actual).toBe(
			'missing structured receipt (legacy transcript adapter disabled)',
		);
	});

	test('the journaled rejection is bounded to 300 chars', () => {
		const result = validatePrReviewDiscoveryLaneCompletion({
			...baseInput(),
			lastSubmitRejection: 'x'.repeat(500),
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected failure');
		// The journal writer caps at 300 and boundedLaneValidationValue bounds
		// the failure value again; assert boundedness, not an exact cap.
		expect(result.failure.actual).toContain('x'.repeat(50));
		expect(result.failure.actual).not.toContain('x'.repeat(400));
	});
});

describe('journal bound (issue #2859 F3, AGENTS.md §8)', () => {
	test('the gate-state journal cap matches the schema max', () => {
		expect(MAX_PR_REVIEW_SUBMIT_REJECTIONS).toBe(24);
	});
});
