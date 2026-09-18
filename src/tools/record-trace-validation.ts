/**
 * record_trace_validation — persist a per-phase `trace-check.sh` validator
 * receipt for the issue-trace v3 workflow (issue #2564).
 *
 * One entry per validator run: the phase validated, the outcome (pass/fail),
 * and the exact identities the validator reported (reviewedCommit + treeId,
 * both 40-hex). The receipt file upserts per phase — re-running a phase
 * replaces its entry, other phases are preserved — so the reader
 * (issue-trace-state.ts traceValidationReceiptExists) can demand "every
 * recorded phase's latest run passed". The reducer's TRACE_VALIDATION_GATE
 * blocks the commit-pr handoff while any entry is missing, failing, or
 * malformed.
 *
 * The read-modify-write upsert runs under the per-file receipt lock
 * (tryAcquireLock, keyed by this receipt's name — the same keyed-lock family
 * as plan.json and the MCP receipt journal) so concurrent invocations
 * serialize instead of silently dropping entries; contention resolves to
 * serialization or a typed busy failure, never last-writer-wins (issue #2788).
 * The persist step goes through the canonical atomic writer
 * (src/utils/atomic-write.ts), which owns exact own-temp cleanup and the
 * bounded Windows rename retry. The response's `allGreen` field is the gate
 * READER's verdict computed from the persisted receipt — an advisory
 * read-back for the calling agent, never consumed by the reducer.
 */

import * as fs from 'node:fs';
import { z } from 'zod';
import { traceValidationReceiptExists } from '../hooks/issue-trace-state';
import { validateSwarmPath } from '../hooks/utils';
import { tryAcquireLock } from '../parallel/file-locks';
import { atomicWriteSwarmFile } from '../utils/atomic-write';
import { createSwarmTool } from './create-tool';

const HEX40 = /^[0-9a-f]{40}$/;

/** The v3 phase enum trace-check.sh validates (`phase <N>` subcommand). */
const TRACE_VALIDATION_PHASES: readonly string[] = [
	'0',
	'1',
	'2',
	'2.5',
	'3',
	'4',
	'4.2',
	'4.5',
	'4.6',
	'5',
];

const ValidationEntrySchema = z
	.object({
		phase: z.enum(TRACE_VALIDATION_PHASES as [string, ...string[]]),
		outcome: z.enum(['pass', 'fail']),
		reviewedCommit: z.string().regex(HEX40, 'must be a 40-hex commit SHA'),
		treeId: z.string().regex(HEX40, 'must be a 40-hex tree id'),
	})
	.strict();

const RecordTraceValidationArgsSchema = ValidationEntrySchema.extend({
	issueNumber: z.number().int().min(1),
}).strict();

interface StoredValidation {
	phase: string;
	outcome: 'pass' | 'fail';
	reviewedCommit: string;
	treeId: string;
	timestamp: string;
}

export async function executeRecordTraceValidation(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = RecordTraceValidationArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid trace-validation receipt: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	const data = parsed.data;

	let validatedPath: string;
	try {
		validatedPath = validateSwarmPath(directory, 'trace-validation.json');
	} catch (error) {
		return JSON.stringify({
			success: false,
			message:
				error instanceof Error ? error.message : 'Failed to validate path',
		});
	}

	// Per-file receipt lock (issue #2788): the upsert is a read-modify-write
	// over the whole validations array, so concurrent invocations must
	// serialize or fail typed-busy — an unlocked last-writer-wins silently
	// drops the other writer's phase entry. Mirrors withReceiptLock
	// (src/mcp/write-receipts.ts) and withPlanLifecycleLock (plan/manager.ts).
	try {
		const lockResult = await tryAcquireLock(
			directory,
			'trace-validation.json',
			'trace-validation',
			'trace-validation',
		);
		if (!lockResult.acquired) {
			return JSON.stringify({
				success: false,
				message:
					'The trace-validation receipt is locked by another concurrent writer; no write was attempted. Re-run record_trace_validation for this phase once the other writer finishes.',
			});
		}
		try {
			// Read-modify-write upsert: one entry per phase, replaced in place.
			let validations: StoredValidation[] = [];
			try {
				const raw = await fs.promises.readFile(validatedPath, 'utf-8');
				const existing: unknown = JSON.parse(raw);
				if (
					typeof existing === 'object' &&
					existing !== null &&
					Array.isArray((existing as Record<string, unknown>).validations)
				) {
					validations = (
						(existing as Record<string, unknown>).validations as unknown[]
					).filter(
						(v): v is StoredValidation =>
							typeof v === 'object' &&
							v !== null &&
							typeof (v as StoredValidation).phase === 'string',
					);
				}
			} catch {
				// Absent or unreadable receipt — start fresh.
			}
			const entry: StoredValidation = {
				phase: data.phase,
				outcome: data.outcome,
				reviewedCommit: data.reviewedCommit,
				treeId: data.treeId,
				timestamp: new Date().toISOString(),
			};
			const idx = validations.findIndex((v) => v.phase === data.phase);
			if (idx === -1) validations.push(entry);
			else validations[idx] = entry;

			const receipt: Record<string, unknown> = {
				issueNumber: data.issueNumber,
				timestamp: new Date().toISOString(),
				validations,
			};
			if (context.sessionID?.trim())
				receipt.sessionId = context.sessionID.trim();

			await atomicWriteSwarmFile(
				validatedPath,
				JSON.stringify(receipt, null, 2),
			);
			// Read-back through the gate reader: the reported verdict is by
			// construction the TRACE_VALIDATION_GATE's verdict on the persisted
			// bytes, so the advisory response field can never drift from the gate
			// (a lenient local computation once claimed green over malformed
			// entries the reader rejects — issue #2788).
			const allGreen = await traceValidationReceiptExists(
				directory,
				data.issueNumber,
			);
			return JSON.stringify({
				success: true,
				issueNumber: data.issueNumber,
				path: '.swarm/trace-validation.json',
				allGreen,
				message: allGreen
					? `Validator receipt recorded for issue #${data.issueNumber} phase ${data.phase} (${data.outcome}); every recorded phase is green.`
					: `Validator receipt recorded for issue #${data.issueNumber} phase ${data.phase} (${data.outcome}), but at least one recorded phase is failing — fix and re-record that phase as a pass before handoff.`,
			});
		} finally {
			try {
				await lockResult.lock._release?.();
			} catch {
				// The proper-lockfile stale lease is the bounded fallback.
			}
		}
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export const record_trace_validation: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			"Record one per-phase trace-check.sh validator outcome for the current traced issue (issue #2564): the phase (v3 enum 0..5 incl. 2.5/4.2/4.5/4.6), the outcome (pass or fail), and the exact reviewedCommit and treeId the validator reported. Re-running a phase replaces its entry. The /swarm issue --trace workflow will not hand off to commit-pr while any recorded phase is failing or none is recorded. The receipt write is serialized by a per-file receipt lock, and the response's allGreen field mirrors the gate reader's verdict on the persisted receipt (advisory for the calling agent — the reducer always recomputes it independently).",
		args: {
			issueNumber: RecordTraceValidationArgsSchema.shape.issueNumber,
			phase: RecordTraceValidationArgsSchema.shape.phase,
			outcome: RecordTraceValidationArgsSchema.shape.outcome,
			reviewedCommit: RecordTraceValidationArgsSchema.shape.reviewedCommit,
			treeId: RecordTraceValidationArgsSchema.shape.treeId,
		},
		execute: executeRecordTraceValidation,
	});
