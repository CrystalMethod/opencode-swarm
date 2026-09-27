import {
	backfillMembershipPhaseIds,
	inspectMembershipPhaseIds,
	type ReceiptLedgerResult,
	type ReceiptPhaseIdInspection,
} from '../hooks/knowledge-receipt-ledger.js';

/**
 * #2947 `/swarm doctor` section: `knowledge-receipt-phase-id`.
 *
 * Detection is always-on and takes the ledger lock like every ledger read;
 * on a legacy store that has not completed cutover yet, a detection call can
 * append the standard `legacy_unverifiable`/`cutover_completed` bootstrap
 * records (base-identical behavior of every `runLocked` read — no phase-data
 * mutation). The journaled backfill runs ONLY under the interactive `--fix`
 * flag. Fail-open on lock or store errors — the doctor is advisory and must
 * still produce its structural report. INVARIANT 1 (AGENTS.md): this section
 * is wired exclusively into the interactive `handleDoctorCommand` and is
 * deliberately absent from `runConfigDoctor`/`runConfigDoctorWithFixes`, so
 * no receipt-journal scan or backfill write can execute on the plugin startup
 * path (src/index.ts registers the startup doctor via those services only).
 */
export async function renderKnowledgeReceiptPhaseIdSection(
	directory: string,
	enableAutoFix: boolean,
): Promise<string> {
	let inspection: ReceiptLedgerResult<ReceiptPhaseIdInspection>;
	try {
		inspection = await inspectMembershipPhaseIds(directory);
	} catch {
		return section(
			'skipped: knowledge receipt ledger could not be read (advisory check, fail-open).',
		);
	}
	if (!inspection.ok) {
		if (inspection.code === 'lock_timeout') {
			return section(
				'skipped: ledger lock busy — run repair_knowledge_receipt_ledger with operation backfill_phase_id on demand.',
			);
		}
		return section(
			`skipped: ledger unavailable (${inspection.code}) — run repair_knowledge_receipt_ledger (default operation) to diagnose and repair.`,
		);
	}
	const { missing, backfillable, unparsable } = inspection;
	if (missing === 0) {
		return enableAutoFix
			? section('all live memberships carry a phase_id.')
			: '';
	}
	let fixedNote = '';
	if (enableAutoFix && backfillable > 0) {
		const backfill = await backfillMembershipPhaseIds(directory).catch(
			() => null,
		);
		if (backfill?.ok) {
			const after = await inspectMembershipPhaseIds(directory).catch(
				() => null,
			);
			const remaining = after?.ok
				? after.missing
				: missing - (backfill.backfilled ?? 0);
			fixedNote = ` (--fix applied: ${backfill.backfilled} membership(s) backfilled; ${remaining} still lacking a phase id)`;
		} else {
			fixedNote =
				' (--fix attempted but the backfill did not complete; run repair_knowledge_receipt_ledger with operation backfill_phase_id)';
		}
	}
	const lines = [
		`${missing} live receipt membership(s) lack a stable phase_id; ${backfillable} backfillable from their stored label.`,
	];
	for (const row of unparsable.slice(0, 10)) {
		const label = row.label
			? `"${row.label.slice(0, 80).replace(/[\r\n]+/g, ' ')}"`
			: ' (no label)';
		lines.push(
			`  - unparsable label on ${row.trace_id}/${row.entry_id}: ${label}`,
		);
	}
	if (unparsable.length > 10)
		lines.push(`  - … and ${unparsable.length - 10} more`);
	lines.push(
		enableAutoFix
			? ''
			: 'Run /swarm doctor --fix to backfill ids from stored labels, or repair_knowledge_receipt_ledger with operation backfill_phase_id.',
	);
	return section(`${lines.filter((l) => l !== '').join('\n')}${fixedNote}`);
}

function section(body: string): string {
	if (!body.trim()) return '';
	return `\n---\n\n## Knowledge Receipt Phase IDs\n\n${body}\n`;
}
