/**
 * Bounded reader for the durable PR_REVIEW trigger-evaluation receipt
 * (issue #2840).
 *
 * Contract: given the gate state's `prReviewTriggerEvalPath`, this module
 * performs the exact bounded read the candidate-inventory pass has always
 * done (path validation, file-type + byte-cap check, JSON parse, strict
 * receipt parse) and returns the parsed receipt. When the path is unset the
 * reader returns `{ noReceipt: true }` WITHOUT touching the filesystem — a
 * run that never wrote a trigger-eval receipt (pre-#2836 runs, runs without
 * micro triggers) must not read, and must not be treated as degraded. A set
 * path whose file is missing, oversized, or unparseable throws BLOCKED —
 * mirroring the inventory pass: corruption of a receipt the workflow claims
 * to have written must fail closed, never silently downgrade a degraded
 * review to an APPROVEable one.
 *
 * Kept in its own module (not the pure schema module
 * `pr-review-trigger-contract.ts`, not the gate) so both
 * `src/hooks/pr-workflow-gate.ts` and `src/pr-review/completion.ts` can
 * share it without an import cycle.
 */

import { readFileSync, statSync } from 'node:fs';
import { validateSwarmPath } from '../hooks/utils';
import {
	PR_REVIEW_TRIGGER_RECEIPT_MAX_BYTES,
	parsePrReviewTriggerReceipt,
} from './pr-review-trigger-contract.js';

export type PrReviewTriggerReceiptRead =
	| { noReceipt: true }
	| { receipt: ReturnType<typeof parsePrReviewTriggerReceipt> };

export function readPrReviewTriggerReceiptForGate(
	directory: string,
	triggerEvalPath: string | null | undefined,
): PrReviewTriggerReceiptRead {
	if (!triggerEvalPath) return { noReceipt: true };
	const triggerPath = validateSwarmPath(directory, triggerEvalPath);
	let triggerArtifact: unknown;
	try {
		const triggerStat = statSync(triggerPath);
		if (
			!triggerStat.isFile() ||
			triggerStat.size > PR_REVIEW_TRIGGER_RECEIPT_MAX_BYTES
		) {
			throw new Error('trigger evaluation artifact exceeds its read bound');
		}
		triggerArtifact = JSON.parse(readFileSync(triggerPath, 'utf-8'));
	} catch {
		throw new Error(
			'BLOCKED: PR_REVIEW trigger evaluation artifact is missing or invalid',
		);
	}
	try {
		return { receipt: parsePrReviewTriggerReceipt(triggerArtifact) };
	} catch (error) {
		throw new Error(
			`BLOCKED: PR_REVIEW trigger evaluation is invalid: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/**
 * True when the durable trigger-eval receipt discloses at least one coverage
 * degradation (dead family or coverage-quality). Issue #2840: such a review
 * is DEGRADED_DISCLOSED and its verdict matrix must never include APPROVE.
 * Unset path ⇒ false (no receipt was ever written for this run).
 */
export function prReviewReceiptHasCoverageDegradations(
	directory: string,
	triggerEvalPath: string | null | undefined,
): boolean {
	const read = readPrReviewTriggerReceiptForGate(directory, triggerEvalPath);
	return 'noReceipt' in read
		? false
		: read.receipt.coverageDegradations.length > 0;
}
