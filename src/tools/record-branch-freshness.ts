/**
 * record_branch_freshness — persist the issue-tracer v3 Phase 0
 * branch-freshness receipt (issue #2564).
 *
 * Mirrors trace-check.sh phase0: the receipt RECORDS the fetch outcome —
 * `synced`, `behind:<n>`, or `fetch-failed:<reason>` — and an optional
 * verbatim user override string. Recording any outcome is a successful write;
 * the READER (issue-trace-state.ts branchFreshnessReceiptExists) decides
 * whether the outcome permits the trace: synced permits, behind never
 * permits, fetch-failed permits only with a non-empty recorded override.
 * The reducer's FRESHNESS_GATE consumes that verdict before PLAN.
 *
 * The persist step goes through the canonical atomic writer
 * (src/utils/atomic-write.ts), which owns exact own-temp cleanup and the
 * bounded Windows rename retry (issue #2788). The response's `permits` field
 * is the gate READER's verdict computed from the persisted receipt — an
 * advisory read-back for the calling agent, never consumed by the reducer.
 */

import { z } from 'zod';
import { branchFreshnessReceiptExists } from '../hooks/issue-trace-state';
import { validateSwarmPath } from '../hooks/utils';
import { atomicWriteSwarmFile } from '../utils/atomic-write';
import { createSwarmTool } from './create-tool';

const FreshnessValueSchema = z
	.string()
	.trim()
	.min(1)
	.max(500)
	.regex(
		/^(synced|behind:[1-9][0-9]*|fetch-failed:\S+)$/,
		"must be 'synced', 'behind:<n>', or 'fetch-failed:<reason>' (reason contains no whitespace)",
	);

const RecordBranchFreshnessArgsSchema = z
	.object({
		issueNumber: z.number().int().min(1),
		/** Fetch outcome exactly as phase 0 recorded it. */
		freshness: FreshnessValueSchema,
		/** Verbatim user override accepting a failed fetch; rescues fetch-failed only. */
		override: z.string().trim().min(1).max(4000).optional(),
	})
	.strict();

export async function executeRecordBranchFreshness(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = RecordBranchFreshnessArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid branch-freshness receipt: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	const data = parsed.data;
	if (data.freshness === 'synced' && data.override) {
		return JSON.stringify({
			success: false,
			message:
				'An override is only meaningful for a fetch-failed outcome; a synced base needs none.',
		});
	}

	const receipt: Record<string, unknown> = {
		issueNumber: data.issueNumber,
		freshness: data.freshness,
		timestamp: new Date().toISOString(),
	};
	if (data.override) receipt.override = data.override;
	if (context.sessionID?.trim()) receipt.sessionId = context.sessionID.trim();

	let validatedPath: string;
	try {
		validatedPath = validateSwarmPath(directory, 'branch-freshness.json');
	} catch (error) {
		return JSON.stringify({
			success: false,
			message:
				error instanceof Error ? error.message : 'Failed to validate path',
		});
	}

	try {
		await atomicWriteSwarmFile(validatedPath, JSON.stringify(receipt, null, 2));
		// Read-back through the gate reader: the reported verdict is by
		// construction the FRESHNESS_GATE's verdict on the persisted bytes, so
		// the advisory response field can never drift from the gate (issue #2788).
		const permits = await branchFreshnessReceiptExists(
			directory,
			data.issueNumber,
		);
		return JSON.stringify({
			success: true,
			issueNumber: data.issueNumber,
			path: '.swarm/branch-freshness.json',
			permits,
			message: permits
				? `Branch-freshness receipt recorded for issue #${data.issueNumber}; the trace's freshness gate is satisfied.`
				: `Branch-freshness receipt recorded for issue #${data.issueNumber}, but the outcome (${data.freshness}) does NOT permit the trace — ${
						data.freshness.startsWith('behind:')
							? 're-sync with the default branch and re-record as synced.'
							: 'a fetch-failed outcome without a recorded user override fails closed.'
					}`,
		});
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export const record_branch_freshness: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Record the Phase 0 branch-freshness outcome for the current traced issue (issue #2564): freshness is "synced", "behind:<n>", or "fetch-failed:<reason>" exactly as the fetch recorded it, plus an optional verbatim user override for a failed fetch. The /swarm issue --trace workflow will not transition to PLAN until the recorded outcome permits (synced, or fetch-failed with an override). The response\'s permits field mirrors the gate reader\'s verdict on the persisted receipt (advisory for the calling agent — the reducer always recomputes it independently).',
		args: {
			issueNumber: RecordBranchFreshnessArgsSchema.shape.issueNumber,
			freshness: RecordBranchFreshnessArgsSchema.shape.freshness,
			override: RecordBranchFreshnessArgsSchema.shape.override,
		},
		execute: executeRecordBranchFreshness,
	});
