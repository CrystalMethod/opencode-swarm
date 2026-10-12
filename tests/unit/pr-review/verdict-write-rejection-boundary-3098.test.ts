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
 * Issue #3098 implementation-review round 1 (non-frozen companion to the
 * frozen C2 suite): the BOUNDARY rejection arm — the exact-inventory
 * "legal next checkpoint" contract rejection that motivated the verdict
 * journal — must land in `prReviewVerdictRejections`, not only the schema
 * arm the frozen suite drives. A valid findings payload whose records do
 * NOT match the authoritative verdicts fails the boundary admission and
 * must be journalled with the boundary attribution.
 */

const RUN_ID = 'boundary-journal-run';

function gateStatePath(): string {
	return join(
		tempDir,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
	);
}

function readJournal(): Array<Record<string, unknown>> {
	const state = JSON.parse(readFileSync(gateStatePath(), 'utf8')) as {
		prReviewVerdictRejections?: Array<Record<string, unknown>>;
	};
	return state.prReviewVerdictRejections ?? [];
}

describe('boundary rejections land in the verdict journal (issue #3098 review round)', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('a boundary-contract rejection is journalled with the boundary attribution', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		// A schema-VALID findings payload with no prior boundaries committed:
		// post_explorer IS the legal first boundary, but the record set cannot
		// match the authoritative candidate verdicts (none exist yet), so the
		// admission contract rejects with the exact-inventory message.
		const raw = await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: RUN_ID,
				pr_head_sha: HEAD_SHA,
				boundary: 'post_explorer',
				records: [
					{
						finding_id: 'C-0',
						status: 'PENDING',
						file_line: 'src/index.ts:1',
						evidence: 'boundary journal fixture evidence',
						next_action: 'route_to_reviewer',
						severity: 'HIGH',
					},
				],
			},
			tempDir,
			{ sessionID: SESSION_ID },
		);
		const outcome = JSON.parse(raw) as { success: boolean; message: string };
		expect(outcome.success).toBeFalse();
		const journal = readJournal();
		expect(journal.length).toBeGreaterThanOrEqual(1);
		const entry = journal.at(-1) as
			| { boundary?: string; message?: string }
			| undefined;
		expect(entry?.boundary).toBe('post_explorer');
		expect(entry?.message).toContain('post_explorer');
		expect(entry?.message?.length ?? 0).toBeLessThanOrEqual(300);
	});
});
