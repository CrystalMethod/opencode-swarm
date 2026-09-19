/**
 * record_recurrence_sweep — persist an issue-bound recurrence-sweep receipt for
 * the issue-trace workflow (issue #2131 residual criterion B).
 *
 * Modeled on issue-tracer Phase 4.2: for a real defect class the sweep must
 * record the pattern statement, explicit search predicates, a typed
 * disposition for every hit, and a guardrail with proof it catches the
 * original defect. The "no defect class" fast path (a change that corrects no
 * incorrect behavior) requires a one-line justification. The trace engine will
 * not hand off to commit-pr until this receipt (or a real defect-class sweep)
 * exists; the reader validates the same shape.
 */

import { z } from 'zod';
import { validateSwarmPath } from '../hooks/utils';
import { atomicWriteSwarmFile } from '../utils/atomic-write';
import { createSwarmTool } from './create-tool';

const DispositionSchema = z
	.object({
		ref: z.string().trim().min(1).max(500),
		disposition: z.enum([
			'FIX',
			'FALSE_POSITIVE',
			'OUT_OF_CLASS',
			'DEFERRED_WITH_USER_APPROVAL',
		]),
		note: z.string().trim().max(1000).optional(),
	})
	.strict();

const GuardrailSchema = z
	.object({
		kind: z.enum([
			'lint-static-analysis',
			'type-level',
			'runtime-assertion',
			'ci-check',
			'documented-invariant-plus-regression-test',
		]),
		description: z.string().trim().min(8).max(2000),
		proof: z.string().trim().min(8).max(4000),
	})
	.strict();

const RelatedProblemSchema = z
	.object({
		ref: z.string().trim().min(1).max(500),
		note: z.string().trim().max(1000).optional(),
	})
	.strict();

const RecordRecurrenceSweepArgsSchema = z
	.object({
		issueNumber: z.number().int().min(1),
		/** One-sentence defect-class characterization, or the literal 'no defect class' fast path. */
		defectClass: z.string().trim().min(1).max(1000),
		justification: z.string().trim().min(1).max(1000).optional(),
		predicates: z
			.array(z.string().trim().min(1).max(500))
			.min(1)
			.max(32)
			.optional(),
		// Issue #2600 (DD-C009): non-vacuous — `dispositions: []` is
		// indistinguishable from a sweep that never ran. A real defect class
		// always has at least one disposition (the original defect site itself,
		// dispositioned FIX).
		dispositions: z.array(DispositionSchema).min(1).max(200).optional(),
		guardrail: GuardrailSchema.optional(),
		/**
		 * Phase 1 related-problems sweep results (issue #2564): the related
		 * issues/PRs the intake sweep found, seeding the defect class. Required
		 * on BOTH paths — the sweep runs in Phase 1 regardless of defect class —
		 * and non-vacuous: at least one entry with a non-empty ref.
		 */
		relatedProblems: z.array(RelatedProblemSchema).min(1).max(200),
	})
	.strict();

export async function executeRecordRecurrenceSweep(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = RecordRecurrenceSweepArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid recurrence sweep receipt: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	const data = parsed.data;
	const noDefectClass = data.defectClass === 'no defect class';
	if (noDefectClass) {
		if (!data.justification) {
			return JSON.stringify({
				success: false,
				message:
					'The "no defect class" fast path requires a one-line justification.',
			});
		}
	} else if (
		!data.predicates ||
		data.predicates.length === 0 ||
		!data.dispositions ||
		data.dispositions.length === 0 ||
		!data.guardrail
	) {
		return JSON.stringify({
			success: false,
			message:
				'A defect-class sweep requires search predicates, a non-empty disposition for every hit (at least one — the original defect site itself, dispositioned FIX), and a guardrail with proof it catches the original defect. An empty dispositions array is indistinguishable from a sweep that never ran.',
		});
	}

	const receipt: Record<string, unknown> = {
		issueNumber: data.issueNumber,
		defectClass: data.defectClass,
		timestamp: new Date().toISOString(),
	};
	if (data.justification) receipt.justification = data.justification;
	if (data.predicates) receipt.predicates = data.predicates;
	if (data.dispositions) receipt.dispositions = data.dispositions;
	if (data.guardrail) receipt.guardrail = data.guardrail;
	receipt.relatedProblems = data.relatedProblems;
	if (context.sessionID?.trim()) receipt.sessionId = context.sessionID.trim();

	let validatedPath: string;
	try {
		validatedPath = validateSwarmPath(directory, 'recurrence-sweep.json');
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
			path: '.swarm/recurrence-sweep.json',
			message: noDefectClass
				? `Recurrence sweep recorded for issue #${data.issueNumber} (no defect class fast path).`
				: `Recurrence sweep recorded for issue #${data.issueNumber}; the trace may now satisfy its recurrence gate.`,
		});
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export const record_recurrence_sweep: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Record the recurrence sweep for the current traced issue (issue #2131 residual B; widened in #2564 and #2600). The /swarm issue --trace workflow will not hand off to commit-pr until this receipt exists. Supply relatedProblems (the Phase 1 related-problems sweep results — at least one {ref, note?} entry) plus, for a real defect class: defectClass (one-sentence characterization), predicates (the exact search predicates), dispositions (non-empty — every hit as FIX / FALSE_POSITIVE / OUT_OF_CLASS / DEFERRED_WITH_USER_APPROVAL, including the original defect site), and a guardrail (kind + description + proof it catches the original defect). If the change corrects no incorrect behavior, use the literal defectClass "no defect class" with a one-line justification (relatedProblems still required).',
		args: {
			issueNumber: RecordRecurrenceSweepArgsSchema.shape.issueNumber,
			defectClass: RecordRecurrenceSweepArgsSchema.shape.defectClass,
			justification: RecordRecurrenceSweepArgsSchema.shape.justification,
			predicates: RecordRecurrenceSweepArgsSchema.shape.predicates,
			dispositions: RecordRecurrenceSweepArgsSchema.shape.dispositions,
			guardrail: RecordRecurrenceSweepArgsSchema.shape.guardrail,
			relatedProblems: RecordRecurrenceSweepArgsSchema.shape.relatedProblems,
		},
		execute: executeRecordRecurrenceSweep,
	});
