import { z } from 'zod';
import { PrReviewLaneResultEnvelopeSchema } from '../background/pr-review-contract.js';
import {
	recordPrReviewSubmitRejection,
	submitPrReviewResult,
} from '../hooks/pr-workflow-gate.js';
import { canonicalRootKeyFresh } from '../utils/canonical-root.js';
import { createSwarmTool } from './create-tool.js';

// Issue #2859 (F2): the string form "1" is accepted and normalized to the JSON
// number 1 via preprocess, which keeps the inner literal's exact rejection
// message ("Invalid input: expected 1") and its literal output type. A plain
// z.coerce.number() is deliberately NOT used here: coercion maps true -> 1
// (Number(true) === 1), which would accept schemaVersion: true. Only "1" is
// normalized; 2, "2", true, and null reach the literal unchanged and fail.
const SubmitPrReviewResultArgsSchema = z
	.object({
		schemaVersion: z
			.preprocess((value) => (value === '1' ? 1 : value), z.literal(1))
			.describe('the JSON number 1 (the string "1" is also accepted)'),
		batchId: z.string().trim().min(1).max(120).optional(),
		laneId: z.string().trim().min(1).max(120).optional(),
		revisionDigest: z
			.string()
			.trim()
			.regex(/^[0-9a-f]{64}$/i),
		result: PrReviewLaneResultEnvelopeSchema,
	})
	.strict();

// Issue #2859 (F1): a rejection that names only the expected value is
// indistinguishable to the child from what it believes it sent ("expected 1"
// renders identically for "1", 2, "2", true, and null), so blind retry is the
// rational child response. Render the RECEIVED value, bounded.
export const RECEIVED_VALUE_RENDER_LIMIT = 120;
// PR #2863 review (PRR-003): each received value is bounded above, but the
// joined issue list was not. An adversarial multi-issue payload could hand
// the child a multi-KB rejection, defeating F1 self-diagnosis; cap the
// total child-visible message with an explicit truncation note.
const MAX_FORMATTED_ISSUE_MESSAGE_CHARS = 2_000;

function resolveReceivedValue(
	args: unknown,
	path: readonly PropertyKey[],
): unknown {
	let current: unknown = args;
	for (const key of path) {
		if (current === null || typeof current !== 'object') return undefined;
		current = (current as Record<PropertyKey, unknown>)[key];
	}
	return current;
}

function renderReceivedValue(value: unknown): string {
	const typeofLabel = typeof value;
	if (value === undefined) return 'received undefined';
	let rendered: string;
	try {
		rendered = JSON.stringify(value) ?? 'null';
	} catch {
		return `received <unrepresentable> (${typeofLabel})`;
	}
	if (rendered.length > RECEIVED_VALUE_RENDER_LIMIT) {
		rendered = `${rendered.slice(0, RECEIVED_VALUE_RENDER_LIMIT)}…`;
	}
	return `received ${rendered} (${typeofLabel})`;
}

const UNRECOGNIZED_KEY_PATTERN = /Unrecognized key: "([^"]*)"/;

function formatSubmitValidationIssues(
	args: unknown,
	issues: z.ZodIssue[],
): string {
	const joined = issues
		.map((issue) => {
			const pathLabel = issue.path.length > 0 ? issue.path.join('.') : '(root)';
			let receivedSource: unknown;
			let haveReceivedSource = false;
			if (issue.path.length > 0) {
				receivedSource = resolveReceivedValue(args, issue.path);
				haveReceivedSource = true;
			} else {
				// Strict-mode unknown keys carry an empty path; the message already
				// names the key, so resolve that key's value for the received clause.
				const key = UNRECOGNIZED_KEY_PATTERN.exec(issue.message)?.[1];
				if (key !== undefined && args !== null && typeof args === 'object') {
					receivedSource = (args as Record<string, unknown>)[key];
					haveReceivedSource = true;
				}
			}
			const received = haveReceivedSource
				? ` (${renderReceivedValue(receivedSource)})`
				: '';
			return `${pathLabel}: ${issue.message}${received}`;
		})
		.join('; ');
	if (joined.length <= MAX_FORMATTED_ISSUE_MESSAGE_CHARS) {
		return joined;
	}
	return `${joined.slice(0, MAX_FORMATTED_ISSUE_MESSAGE_CHARS)}… [truncated: ${issues.length} validation issue(s) exceed the ${MAX_FORMATTED_ISSUE_MESSAGE_CHARS}-char diagnostic budget; fix the first listed issue(s) and resubmit]`;
}

/**
 * Issue #2859 (F1): per-child consecutive-rejection counter that drives the
 * escalating hint. Keyed by directory + child session; bounded FIFO per
 * AGENTS.md invariant 8 (same eviction pattern as pr-event-delivery.ts).
 */
const MAX_TRACKED_SUBMIT_SESSIONS = 128;
const SUBMIT_REJECTION_HINT_THRESHOLD = 3;
const consecutiveSubmitRejections = new Map<string, number>();

function submitRejectionKey(directory: string, sessionID: string): string {
	// Canonical project-root key: two lexical spellings of one project must
	// share one rejection counter (path-identity contract, canonical-root.ts).
	return (
		`${canonicalRootKeyFresh(directory)}` + String.fromCharCode(0) + sessionID
	);
}

function noteSubmitRejection(directory: string, sessionID: string): number {
	const key = submitRejectionKey(directory, sessionID);
	const next = (consecutiveSubmitRejections.get(key) ?? 0) + 1;
	consecutiveSubmitRejections.set(key, next);
	while (consecutiveSubmitRejections.size > MAX_TRACKED_SUBMIT_SESSIONS) {
		const oldest = consecutiveSubmitRejections.keys().next().value;
		if (oldest === undefined) break;
		consecutiveSubmitRejections.delete(oldest);
	}
	return next;
}

function clearSubmitRejections(directory: string, sessionID: string): void {
	consecutiveSubmitRejections.delete(submitRejectionKey(directory, sessionID));
}

export const _test_exports = {
	resolveReceivedValue,
	renderReceivedValue,
	formatSubmitValidationIssues,
	noteSubmitRejection,
	clearSubmitRejections,
	MAX_TRACKED_SUBMIT_SESSIONS,
	SUBMIT_REJECTION_HINT_THRESHOLD,
};

export async function executeSubmitPrReviewResult(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = SubmitPrReviewResultArgsSchema.safeParse(args);
	const childSessionId = context.sessionID?.trim();
	if (!childSessionId) {
		return JSON.stringify({
			success: false,
			message:
				'submit_pr_review_result requires an authenticated child session',
		});
	}
	if (!parsed.success) {
		const count = noteSubmitRejection(directory, childSessionId);
		const hint =
			count >= SUBMIT_REJECTION_HINT_THRESHOLD
				? ` — ${count} consecutive rejections: re-read the tool schema; do NOT resubmit the same payload shape.`
				: '';
		const message = `Invalid PR-review result: ${formatSubmitValidationIssues(args, parsed.error.issues)}${hint}`;
		// Issue #2859 (F3): journal the enriched rejection so the orchestrator
		// can see why the lane ended contract-failed without a receipt.
		// Fail-open; never changes this rejection outcome.
		await recordPrReviewSubmitRejection(directory, childSessionId, message);
		return JSON.stringify({ success: false, message });
	}
	clearSubmitRejections(directory, childSessionId);
	const outcome = await submitPrReviewResult(directory, childSessionId, {
		...(parsed.data.batchId ? { batchId: parsed.data.batchId } : {}),
		...(parsed.data.laneId ? { laneId: parsed.data.laneId } : {}),
		revisionDigest: parsed.data.revisionDigest,
		result: parsed.data.result,
	});
	return JSON.stringify({
		success: outcome.status === 'recorded' || outcome.status === 'duplicate',
		...outcome,
	});
}

export const submit_pr_review_result: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			"Submit exactly one typed CLEAN, FINDINGS, or INCOMPLETE result for the active child-bound PR-review base/micro lane. The authenticated child session identifies its exact delegation and supplies authoritative batch/lane provenance; optional batchId/laneId values are checked when present. The receipt is atomically bound to the child session, workflow instance, revision, batch, lane, root, base, and head. Identical replay is idempotent; conflicting or late submissions fail closed. Exception (issue #2585): when a lane's child is terminally unavailable (cancelled, stale, or liveness-error), the lane's dispatching parent session may submit one repair receipt for that lane; the receipt records the architect provenance and stays bound to the dead child session. Every other session is still refused. Call once, then stop.",
		args: {
			schemaVersion: SubmitPrReviewResultArgsSchema.shape.schemaVersion,
			batchId: SubmitPrReviewResultArgsSchema.shape.batchId,
			laneId: SubmitPrReviewResultArgsSchema.shape.laneId,
			revisionDigest: SubmitPrReviewResultArgsSchema.shape.revisionDigest,
			result: SubmitPrReviewResultArgsSchema.shape.result,
		},
		execute: executeSubmitPrReviewResult,
	});
