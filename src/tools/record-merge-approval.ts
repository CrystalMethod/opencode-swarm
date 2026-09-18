/**
 * record_merge_approval — persist the PR-head-bound merge-approval receipt
 * (issue-tracer v3 Phase 5.1 / 10b-merge-approval, issue #2564).
 *
 * RECORDED, NEVER CERTIFIED: this receipt mirrors trace-check.sh merge_check's
 * presence-and-binding posture — the PR head SHA must equal the final critic's
 * reviewed commit (both 40-hex), and the user approval is captured VERBATIM.
 * The plugin never verifies the approval's authenticity, never drives the
 * merge, and never treats the receipt as authorization; the merge remains a
 * human-enforced gate. The reducer records the trace's terminal
 * `merge_approval_recorded` status when the reader observes this receipt.
 */

import { z } from 'zod';
import { validateSwarmPath } from '../hooks/utils';
import { atomicWriteSwarmFile } from '../utils/atomic-write';
import { createSwarmTool } from './create-tool';

const HEX40 = /^[0-9a-f]{40}$/;

const RecordMergeApprovalArgsSchema = z
	.object({
		issueNumber: z.number().int().min(1),
		prHeadSha: z.string().regex(HEX40, 'must be a 40-hex commit SHA'),
		finalCriticReviewedCommit: z
			.string()
			.regex(HEX40, 'must be a 40-hex commit SHA'),
		userApprovalVerbatim: z.string().trim().min(1).max(8000),
	})
	.strict();

export async function executeRecordMergeApproval(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = RecordMergeApprovalArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid merge-approval receipt: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	const data = parsed.data;
	// Binding check mirrors trace-check.sh merge_check: the PR head must equal
	// the final critic's reviewed commit. A mismatched pair is rejected at
	// write time so a stale critic verdict can never satisfy this receipt.
	if (data.prHeadSha !== data.finalCriticReviewedCommit) {
		return JSON.stringify({
			success: false,
			message:
				'Merge-approval binding failed: prHeadSha must equal finalCriticReviewedCommit (the final critic approval must be bound to the exact PR head).',
		});
	}

	const receipt: Record<string, unknown> = {
		issueNumber: data.issueNumber,
		prHeadSha: data.prHeadSha,
		finalCriticReviewedCommit: data.finalCriticReviewedCommit,
		userApprovalVerbatim: data.userApprovalVerbatim,
		timestamp: new Date().toISOString(),
	};
	if (context.sessionID?.trim()) receipt.sessionId = context.sessionID.trim();

	let validatedPath: string;
	try {
		validatedPath = validateSwarmPath(directory, 'merge-approval.json');
	} catch (error) {
		return JSON.stringify({
			success: false,
			message:
				error instanceof Error ? error.message : 'Failed to validate path',
		});
	}

	try {
		await atomicWriteSwarmFile(validatedPath, JSON.stringify(receipt, null, 2));
		return JSON.stringify({
			success: true,
			issueNumber: data.issueNumber,
			path: '.swarm/merge-approval.json',
			message: `Merge approval recorded for issue #${data.issueNumber}, bound to PR head ${data.prHeadSha}. The approval is captured verbatim for audit; the merge itself is human-enforced and this plugin neither drives nor certifies it.`,
		});
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export const record_merge_approval: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Record the human merge approval for the current traced issue (issue #2564): prHeadSha and finalCriticReviewedCommit must be the same 40-hex SHA (the final critic approval bound to the exact PR head), and userApprovalVerbatim is the user approval quoted verbatim. The receipt is recorded for audit only — the merge stays human-enforced and the plugin never certifies or drives it.',
		args: {
			issueNumber: RecordMergeApprovalArgsSchema.shape.issueNumber,
			prHeadSha: RecordMergeApprovalArgsSchema.shape.prHeadSha,
			finalCriticReviewedCommit:
				RecordMergeApprovalArgsSchema.shape.finalCriticReviewedCommit,
			userApprovalVerbatim:
				RecordMergeApprovalArgsSchema.shape.userApprovalVerbatim,
		},
		execute: executeRecordMergeApproval,
	});
