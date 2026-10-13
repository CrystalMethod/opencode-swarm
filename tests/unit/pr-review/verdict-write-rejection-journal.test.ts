import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
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
 * Issue #3098 check C2 (DISCRIMINATING). Verdict-lane
 * `write_pr_review_artifact` has ~20 `failure()` rejection sites and journals
 * NOTHING: when a reviewer/critic lane's checkpoint write is rejected, the
 * orchestrator can only learn why from lane prose. The fix adds a mirroring
 * verdict journal (the issue #2859 F3 `recordPrReviewSubmitRejection`
 * precedent): a bounded FIFO `prReviewVerdictRejections` field on the gate
 * state of the tool caller's session — fail-open (never creates gate state,
 * never changes the rejection outcome), redacted, 300-char message bound,
 * deduped on consecutive identical messages.
 *
 * Mirrors tests/unit/tools/collect-lanes-submit-rejection-visibility-2859.test.ts.
 */

interface JournalEntry {
	message: string;
	[key: string]: unknown;
}

function gateStatePath(): string {
	return join(
		tempDir,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
	);
}

function readJournal(): JournalEntry[] {
	const state = JSON.parse(readFileSync(gateStatePath(), 'utf8')) as {
		prReviewVerdictRejections?: JournalEntry[];
	};
	return state.prReviewVerdictRejections ?? [];
}

/** A schema-valid findings payload shape whose ONLY defect is pr_head_sha. */
function rejectedFindingsArgs(offendingHead: string): Record<string, unknown> {
	return {
		kind: 'findings',
		run_id: 'verdict-journal-run',
		pr_head_sha: offendingHead,
		boundary: 'post_explorer',
		records: [
			{
				finding_id: 'C-0',
				status: 'PENDING',
				file_line: 'src/index.ts:1',
				evidence: 'verdict journal fixture evidence',
				next_action: 'route_to_reviewer',
				severity: 'HIGH',
			},
		],
	};
}

const INVALID_HEAD = 'zzq-not-a-hex-sha';

describe('verdict write-rejection journal via the tool layer (issue #3098)', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('a schema-rejected verdict write journals its bounded message on the caller gate state', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		const raw = await executeWritePrReviewArtifact(
			rejectedFindingsArgs(INVALID_HEAD),
			tempDir,
			{ sessionID: SESSION_ID },
		);
		const outcome = JSON.parse(raw) as { success: boolean; message: string };
		// Journaling is observability: the rejection outcome itself is unchanged.
		expect(outcome.success).toBeFalse();
		expect(outcome.message).toContain('Invalid PR-review artifact');

		const journal = readJournal();
		expect(journal).toHaveLength(1);
		expect(journal[0]!.message).toContain('Invalid PR-review artifact');
		expect(journal[0]!.message.length).toBeLessThanOrEqual(300);
	});

	test('identical consecutive rejections dedupe; a different rejection appends', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		// First rejection: journaled.
		await executeWritePrReviewArtifact(
			rejectedFindingsArgs(INVALID_HEAD),
			tempDir,
			{ sessionID: SESSION_ID },
		);
		// Second IDENTICAL rejection: byte-identical message → deduped (a retry
		// loop cannot amplify gate-state writes).
		await executeWritePrReviewArtifact(
			rejectedFindingsArgs(INVALID_HEAD),
			tempDir,
			{ sessionID: SESSION_ID },
		);
		expect(readJournal()).toHaveLength(1);
		// A DIFFERENT rejection (distinct offending value → distinct issue text)
		// appends — observability is preserved for genuinely new information.
		await executeWritePrReviewArtifact(
			rejectedFindingsArgs('zzq-other-not-a-hex-sha'),
			tempDir,
			{ sessionID: SESSION_ID },
		);
		const journal = readJournal();
		expect(journal).toHaveLength(2);
		expect(journal[0]!.message).not.toBe(journal[1]!.message);
	});

	test('the journal is FIFO-bounded: after 30 rejections at most 24 remain, oldest evicted', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		// 30 distinct rejections (each offending head is unique, so each message
		// is distinct and dedupe never suppresses an append).
		for (let index = 0; index < 30; index++) {
			await executeWritePrReviewArtifact(
				rejectedFindingsArgs(`zzq-reject-${String(index).padStart(2, '0')}`),
				tempDir,
				{ sessionID: SESSION_ID },
			);
		}
		const journal = readJournal();
		// The journal must exist and carry the rejections.
		expect(journal.length).toBeGreaterThanOrEqual(1);
		expect(journal[0]!.message).toContain('Invalid PR-review artifact');
		// Cap: the fix's constant is expected to mirror the discovery journal's
		// MAX_PR_REVIEW_SUBMIT_REJECTIONS = 24 (AGENTS.md §8 bounded state).
		expect(journal.length).toBeLessThanOrEqual(24);
		// FIFO eviction, not overwrite: with 30 appends under a 24 cap the six
		// oldest entries are gone — the very first rejection must not survive.
		expect(JSON.stringify(journal)).not.toContain('zzq-reject-00');
		expect(JSON.stringify(journal)).not.toContain('zzq-reject-05');
		// ...while the newest rejection is still journaled.
		expect(JSON.stringify(journal)).toContain('zzq-reject-29');
	});

	test('fail-open: with no gate state the rejection still returns normally and creates nothing', async () => {
		// No activatePrWorkflow on purpose: the caller never opened a gate.
		const raw = await executeWritePrReviewArtifact(
			rejectedFindingsArgs(INVALID_HEAD),
			tempDir,
			{ sessionID: SESSION_ID },
		);
		const outcome = JSON.parse(raw) as { success: boolean; message: string };
		expect(outcome.success).toBeFalse();
		expect(outcome.message).toContain('Invalid PR-review artifact');
		// Journaling must fail open without materializing gate state (or even
		// the gate directory) for a session that never opened a workflow gate.
		expect(
			existsSync(join(tempDir, '.swarm', 'pr-workflow-gates')),
		).toBeFalse();
	});
});
