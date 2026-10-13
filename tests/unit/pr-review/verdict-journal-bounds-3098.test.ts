import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	activatePrWorkflow,
	prWorkflowSessionFileStem,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
import {
	HEAD_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

/**
 * Issue #3098 review closure: the bounds and redaction the journal ADVERTISES but
 * that no frozen check pinned — deleting `redactSecrets`, the 300-char slice, or
 * the cap left the whole suite green (proven by mutation during review).
 * Mirrors the #2859 PRR-002 redaction test for the sibling journal.
 */

const RUN_ID = 'verdict-journal-bounds-run';

function journal(): Array<{ message?: string; boundary?: string }> {
	const state = JSON.parse(
		readFileSync(
			join(
				tempDir,
				'.swarm',
				'pr-workflow-gates',
				`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
			),
			'utf8',
		),
	) as {
		prReviewVerdictRejections?: Array<{ message?: string; boundary?: string }>;
	};
	return state.prReviewVerdictRejections ?? [];
}

/** Schema-valid findings args whose ONLY defect is the offending head string. */
function findingsArgs(prHeadSha: string, extra = ''): Record<string, unknown> {
	return {
		kind: 'findings',
		run_id: RUN_ID,
		pr_head_sha: prHeadSha,
		boundary: 'post_explorer',
		records: [
			{
				finding_id: 'C-0',
				status: 'PENDING',
				file_line: 'src/index.ts:1',
				evidence: `verdict journal bounds fixture${extra}`,
				next_action: 'route_to_reviewer',
				severity: 'HIGH',
			},
		],
	};
}

async function write(prHeadSha: string, extra = ''): Promise<string> {
	const raw = await executeWritePrReviewArtifact(
		findingsArgs(prHeadSha, extra),
		tempDir,
		{ sessionID: SESSION_ID },
	);
	return raw;
}

describe('verdict rejection journal bounds (issue #3098 review closure)', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('a URL-credential-bearing rejection message is redacted in the journal', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		// The offending head is echoed verbatim into the rejection message, so the
		// credential shape flows through the real tool path.
		await write(`https://supertoken:x-oauth-basic@evil.example.com/${RUN_ID}`);
		const entries = journal();
		expect(entries).toHaveLength(1);
		expect(entries[0]!.message ?? '').not.toContain('supertoken');
		expect(entries[0]!.message ?? '').toContain('[REDACTED:url_credentials]@');
	});

	test('a long rejection message is bounded to exactly 300 characters', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		// A 900-char offending head pushes the rendered message well past the cap.
		await write(`zzq-${'q'.repeat(900)}`);
		const entries = journal();
		expect(entries).toHaveLength(1);
		expect(entries[0]!.message ?? '').toHaveLength(300);
	});

	test('the FIFO cap keeps exactly 24 entries, evicting the oldest', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		for (let index = 0; index < 30; index++) {
			await write(`zzq-reject-${String(index).padStart(2, '0')}`);
		}
		const entries = journal();
		// Exact, not an upper bound: any cap in [1,24] passed the frozen suite.
		expect(entries).toHaveLength(24);
		expect(JSON.stringify(entries)).not.toContain('zzq-reject-00');
		expect(JSON.stringify(entries)).not.toContain('zzq-reject-05');
		expect(JSON.stringify(entries)).toContain('zzq-reject-06');
		expect(JSON.stringify(entries)).toContain('zzq-reject-29');
	});

	test('identical messages at different boundaries are not collapsed', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		// Valid hex, so the write clears the schema gate and journalBoundary is
		// assigned; it then fails the head mismatch with a message that carries
		// no boundary token -- byte-identical at every boundary.
		const shared = 'abcdef123456';
		await write(shared);
		const raw = await executeWritePrReviewArtifact(
			{ ...findingsArgs(shared), boundary: 'post_reviewer' },
			tempDir,
			{ sessionID: SESSION_ID },
		);
		expect(JSON.parse(raw).success).toBe(false);
		const boundaries = journal().map((entry) => entry.boundary);
		expect(boundaries).toContain('post_explorer');
		expect(boundaries).toContain('post_reviewer');
	});

	test('identical messages at the SAME boundary are deduped', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		await write('abcdef123456');
		await write('abcdef123456');
		expect(journal()).toHaveLength(1);
	});

	test('a boundary-less schema rejection is still journaled and readable', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		// Schema-rejected: never parses to a boundary, so the entry carries no
		// attribution. It must still be recorded rather than silently dropped.
		const raw = await executeWritePrReviewArtifact(
			{ kind: 'findings' },
			tempDir,
			{ sessionID: SESSION_ID },
		);
		expect(JSON.parse(raw).success).toBe(false);
		const entries = journal();
		expect(entries).toHaveLength(1);
		expect(entries[0]!.boundary).toBeUndefined();
		expect(entries[0]!.message ?? '').toContain('Invalid PR-review artifact');
	});

	test('reader tier order: lane-exact beats boundary, boundary beats boundary-less', async () => {
		// The FB-009 fallback tiers are only meaningful if the ORDER is pinned:
		// a newer, weaker entry must never shadow an exact or boundary match.
		const { latestPrReviewVerdictRejectionForLane } = await import(
			'../../../src/hooks/pr-workflow-gate.js'
		);
		const state = {
			prReviewVerdictRejections: [
				{
					sessionId: 's',
					at: 1,
					message: 'lane-exact message',
					laneId: 'lane-a',
					workflowLane: 'lane-a',
				},
				{
					sessionId: 's',
					at: 2,
					message: 'boundary message',
					boundary: 'post_reviewer',
				},
				{ sessionId: 's', at: 3, message: 'boundary-less message' },
			],
		};
		// Lane-exact wins over the newer boundary and boundary-less entries.
		expect(
			latestPrReviewVerdictRejectionForLane(state, {
				workflowLane: 'lane-a',
				laneIds: ['lane-a'],
				boundary: 'post_reviewer',
			}),
		).toBe('lane-exact message');
		// No lane match: the boundary tier wins over the newer boundary-less one.
		expect(
			latestPrReviewVerdictRejectionForLane(state, {
				workflowLane: 'lane-unknown',
				boundary: 'post_reviewer',
			}),
		).toBe('boundary message');
		// No lane or boundary match: the boundary-less tier is the last resort.
		expect(
			latestPrReviewVerdictRejectionForLane(state, {
				workflowLane: 'lane-unknown',
				boundary: 'post_critic',
			}),
		).toBe('boundary-less message');
		// An empty journal returns undefined rather than throwing.
		expect(
			latestPrReviewVerdictRejectionForLane({}, { workflowLane: 'lane-a' }),
		).toBeUndefined();
	});
});
