import type { ToolContext, ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import {
	backfillMembershipPhaseIds,
	type RepairKnowledgeReceiptLedgerInput,
	repairKnowledgeReceiptLedger,
} from '../hooks/knowledge-receipt-ledger.js';
import { createSwarmTool } from './create-tool.js';
import { resolveWorkingDirectory } from './resolve-working-directory.js';

export async function executeRepairKnowledgeReceiptLedger(
	args: RepairKnowledgeReceiptLedgerInput & {
		working_directory?: string;
		operation?: 'repair' | 'backfill_phase_id';
	},
	directory: string,
	_ctx?: ToolContext,
) {
	try {
		if (
			_ctx &&
			stripKnownSwarmPrefix(_ctx.agent ?? '').toLowerCase() !== 'architect'
		) {
			return {
				success: false,
				message: 'Only the architect may repair the knowledge receipt ledger.',
				errors: ['RECEIPT_REPAIR_ARCHITECT_ONLY'],
			};
		}
		if (_ctx?.sessionID && args.session_id !== _ctx.sessionID) {
			return {
				success: false,
				message:
					'repair_knowledge_receipt_ledger session_id must match the invoking tool context.',
				errors: ['RECEIPT_REPAIR_SESSION_MISMATCH'],
			};
		}
		const resolved = resolveWorkingDirectory(args.working_directory, directory);
		if (!resolved.success) {
			return {
				success: false,
				message: resolved.message,
				errors: [resolved.message],
			};
		}
		// #2947: explicit, on-demand phase_id backfill (the same journaled
		// operation /swarm doctor --fix applies) for stores whose lock was busy
		// at doctor time or that are repaired headlessly.
		if (args.operation === 'backfill_phase_id') {
			const backfill = await backfillMembershipPhaseIds(resolved.directory);
			if (!backfill.ok) {
				return {
					success: false,
					message: 'repair_knowledge_receipt_ledger backfill_phase_id failed',
					errors: [backfill.detail],
					code: backfill.code,
				};
			}
			return {
				success: true,
				message: `phase_id backfill complete: ${backfill.backfilled} membership(s) backfilled, ${backfill.skipped.length} skipped (unparsable label), ${backfill.journal_records} journal record(s) appended. Stored labels are never rewritten.`,
				// Bounded response: the full skipped list can be large on a big
				// legacy store; the count plus the first 20 rows suffice.
				backfilled: backfill.backfilled,
				skipped: backfill.skipped.slice(0, 20),
				skipped_total: backfill.skipped.length,
				journal_records: backfill.journal_records,
			};
		}
		const result = await repairKnowledgeReceiptLedger(resolved.directory, args);
		if (!result.ok) {
			return {
				success: false,
				message: 'repair_knowledge_receipt_ledger failed',
				errors: [result.detail],
				code: result.code,
			};
		}
		const reEvaluationArgs = JSON.stringify({
			repair_id: result.repair_id,
			phase: args.phase,
			...(args.task_id ? { task_id: args.task_id } : {}),
			scope_complete: true,
		});
		return {
			success: true,
			message:
				result.status === 'validated_projection'
					? 'knowledge receipt projection validated'
					: result.status === 'pending_re_evaluation'
						? `knowledge receipt ledger still pending re-evaluation; as architect, run knowledge_recall with a comprehensive query and repair_re_evaluation ${reEvaluationArgs}`
						: `knowledge receipt ledger repaired and blocked pending re-evaluation; as architect, run knowledge_recall with a comprehensive query and repair_re_evaluation ${reEvaluationArgs}`,
			...result,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			message: 'repair_knowledge_receipt_ledger failed',
			errors: [message],
		};
	}
}

export const repair_knowledge_receipt_ledger: ToolDefinition = createSwarmTool({
	description:
		'Architect-only repair and validation for the authoritative knowledge receipt ledger. Default operation repairs: rebuilds the derived projection when authority is readable, or quarantines a bounded corrupt authority, salvages only the validated prefix, and blocks the exact phase/session until a fresh re-evaluation is committed. operation backfill_phase_id durably stamps the stable numeric phase_id on live memberships that lack one across the WHOLE ledger (phase/session_id are not used to scope the backfill; labels never rewritten).',
	args: {
		phase: z.string().min(1),
		session_id: z.string().min(1),
		task_id: z.string().min(1).optional(),
		reason: z.string().min(1).max(2000),
		operation: z.enum(['repair', 'backfill_phase_id']).optional(),
		grace_days: z.number().int().min(0).optional(),
		working_directory: z.string().optional(),
	},
	execute: async (args: unknown, directory: string, ctx?: ToolContext) =>
		JSON.stringify(
			await executeRepairKnowledgeReceiptLedger(
				args as RepairKnowledgeReceiptLedgerInput & {
					working_directory?: string;
					operation?: 'repair' | 'backfill_phase_id';
				},
				directory,
				ctx,
			),
			null,
			2,
		),
});
