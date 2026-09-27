import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderKnowledgeReceiptPhaseIdSection } from '../../../src/commands/doctor-knowledge-receipt-phase-id.js';
import {
	backfillMembershipPhaseIds,
	commitDisplayedMembership,
	inspectMembershipPhaseIds,
	queryLiveMemberships,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { executeRepairKnowledgeReceiptLedger } from '../../../src/tools/repair-knowledge-receipt-ledger.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const directories: string[] = [];

afterEach(() => {
	while (directories.length) {
		const dir = directories.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function scratch(): string {
	const dir = canonicalMkdtemp('receipt-phase-id-rebind-');
	writeFileSync(`${dir}/.git`, 'gitdir: fixture');
	directories.push(dir);
	return dir;
}

function journalLines(dir: string): number {
	try {
		return readFileSync(
			join(dir, '.swarm', 'knowledge-receipts-v2.jsonl'),
			'utf8',
		)
			.split('\n')
			.filter(Boolean).length;
	} catch {
		return 0;
	}
}

const COMPOSED = 'Phase 2: Implement [IN PROGRESS]';
const SHORT = 'Phase 2';
const WEIRD = 'weird label';

async function seedThree(dir: string) {
	for (const [traceId, entryId, phase] of [
		['trace-a', 'entry-1', COMPOSED],
		['trace-a', 'entry-2', SHORT],
		['trace-b', 'entry-3', WEIRD],
	] as const) {
		const committed = await commitDisplayedMembership(dir, {
			trace_id: traceId,
			session_id: 's1',
			phase,
			exposure_kind: 'delegate_directive',
			entries: [{ entry_id: entryId, critical: true }],
		});
		expect(committed.ok).toBe(true);
	}
}

describe('backfillMembershipPhaseIds — regression: label-keyed records lack a stable id (#2947)', () => {
	test('backfills parsable rows, skips unparsable, never rewrites labels, idempotent', async () => {
		const dir = scratch();
		await seedThree(dir);
		const before = await queryLiveMemberships(dir, { session_id: 's1' });
		const labelsBefore = new Map(
			before.ok
				? before.memberships.map((m) => [
						`${m.trace_id}/${m.entry_id}`,
						m.phase,
					])
				: [],
		);
		const linesBefore = journalLines(dir);

		const first = await backfillMembershipPhaseIds(dir);
		expect(first.ok).toBe(true);
		if (first.ok) {
			// Both live label shapes parse: composed `Phase N: name [STATUS]`
			// and the short architect form `Phase N`.
			expect(first.backfilled).toBe(2);
			expect(first.skipped).toHaveLength(1);
			expect(first.skipped[0]).toMatchObject({
				trace_id: 'trace-b',
				entry_id: 'entry-3',
			});
			expect(first.journal_records).toBe(1);
		}

		const after = await queryLiveMemberships(dir, { session_id: 's1' });
		expect(after.ok).toBe(true);
		if (after.ok) {
			const byKey = new Map(
				after.memberships.map((m) => [`${m.trace_id}/${m.entry_id}`, m]),
			);
			expect(byKey.get('trace-a/entry-1')?.phase_id).toBe(2);
			expect(byKey.get('trace-a/entry-2')?.phase_id).toBe(2);
			expect(byKey.get('trace-b/entry-3')?.phase_id).toBeUndefined();
			// Labels byte-identical to before (AC4).
			for (const [key, label] of labelsBefore) {
				expect(byKey.get(key)?.phase).toBe(label);
			}
		}

		// Second run is a no-op: no new journal records (AC4 idempotence).
		const second = await backfillMembershipPhaseIds(dir);
		expect(second.ok).toBe(true);
		if (second.ok) {
			expect(second.backfilled).toBe(0);
			expect(second.journal_records).toBe(0);
		}
		expect(journalLines(dir)).toBe(linesBefore + 1);

		// Post-backfill the store matches by phase_id (AC4).
		const byId = await queryLiveMemberships(dir, {
			phase_id: 2,
			session_id: 's1',
		});
		expect(byId.ok && byId.memberships).toHaveLength(2);
	});

	test('the journaled phase_id_backfilled record replays on the next read', async () => {
		const dir = scratch();
		await seedThree(dir);
		await backfillMembershipPhaseIds(dir);
		const result = await queryLiveMemberships(dir, { session_id: 's1' });
		expect(result.ok).toBe(true);
		const withId = result.ok
			? result.memberships.filter((m) => m.phase_id === 2)
			: [];
		expect(withId).toHaveLength(2);
	});
});

describe('inspectMembershipPhaseIds (doctor detection)', () => {
	test('reports missing, backfillable, and unparsable counts', async () => {
		const dir = scratch();
		await seedThree(dir);
		const inspection = await inspectMembershipPhaseIds(dir);
		expect(inspection.ok).toBe(true);
		if (inspection.ok) {
			expect(inspection.missing).toBe(3);
			expect(inspection.backfillable).toBe(2);
			expect(inspection.unparsable).toHaveLength(1);
		}
	});

	test('clean store reports zero missing', async () => {
		const dir = scratch();
		const inspection = await inspectMembershipPhaseIds(dir);
		expect(inspection.ok).toBe(true);
		if (inspection.ok) expect(inspection.missing).toBe(0);
	});
});

describe('/swarm doctor knowledge-receipt-phase-id section', () => {
	test('detection-only run reports the gap without mutating the journal', async () => {
		const dir = scratch();
		await seedThree(dir);
		const linesBefore = journalLines(dir);
		const section = await renderKnowledgeReceiptPhaseIdSection(dir, false);
		expect(section).toContain('Knowledge Receipt Phase IDs');
		expect(section).toContain('3 live receipt membership(s)');
		expect(section).toContain('2 backfillable');
		expect(journalLines(dir)).toBe(linesBefore);
	});

	test('--fix run backfills and re-reports', async () => {
		const dir = scratch();
		await seedThree(dir);
		const section = await renderKnowledgeReceiptPhaseIdSection(dir, true);
		expect(section).toContain('--fix applied: 2 membership(s) backfilled');
		const inspection = await inspectMembershipPhaseIds(dir);
		expect(inspection.ok && inspection.missing).toBe(1);
	});

	test('clean store renders no section (detection) or the all-clear (--fix)', async () => {
		const dir = scratch();
		expect(await renderKnowledgeReceiptPhaseIdSection(dir, false)).toBe('');
		expect(await renderKnowledgeReceiptPhaseIdSection(dir, true)).toContain(
			'all live memberships carry a phase_id',
		);
	});

	test('the section module is NOT imported by the startup doctor services (invariant 1)', async () => {
		const configDoctor = await readFileSync(
			join('src', 'services', 'config-doctor.ts'),
			'utf8',
		);
		expect(configDoctor).not.toContain('doctor-knowledge-receipt-phase-id');
		const doctorCommand = readFileSync(
			join('src', 'commands', 'doctor.ts'),
			'utf8',
		);
		expect(doctorCommand).toContain('doctor-knowledge-receipt-phase-id');
	});
});

describe('repair_knowledge_receipt_ledger operation backfill_phase_id', () => {
	test('architect invocation backfills through the tool surface', async () => {
		const dir = scratch();
		await seedThree(dir);
		const result = await executeRepairKnowledgeReceiptLedger(
			{
				phase: COMPOSED,
				session_id: 's1',
				reason: 'backfill stable phase ids after the #2947 migration',
				operation: 'backfill_phase_id',
				working_directory: dir,
			},
			dir,
			{ sessionID: 's1', agent: 'architect' },
		);
		expect(result.success).toBe(true);
		const inspection = await inspectMembershipPhaseIds(dir);
		expect(inspection.ok && inspection.missing).toBe(1);
	});

	test('session mismatch is still refused for the backfill operation', async () => {
		const dir = scratch();
		const result = await executeRepairKnowledgeReceiptLedger(
			{
				phase: COMPOSED,
				session_id: 's1',
				reason: 'backfill attempt from a foreign session',
				operation: 'backfill_phase_id',
				working_directory: dir,
			},
			dir,
			{ sessionID: 'other', agent: 'architect' },
		);
		expect(result.success).toBe(false);
		expect(result.errors).toContain('RECEIPT_REPAIR_SESSION_MISMATCH');
	});

	test('non-architect caller is still refused', async () => {
		const dir = scratch();
		const result = await executeRepairKnowledgeReceiptLedger(
			{
				phase: COMPOSED,
				session_id: 's1',
				reason: 'backfill attempt by a non-architect',
				operation: 'backfill_phase_id',
				working_directory: dir,
			},
			dir,
			{ sessionID: 's1', agent: 'reviewer' },
		);
		expect(result.success).toBe(false);
		expect(result.errors).toContain('RECEIPT_REPAIR_ARCHITECT_ONLY');
	});
});
