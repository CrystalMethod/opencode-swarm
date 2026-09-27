import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	backfillMembershipPhaseIds,
	commitDisplayedMembership,
	commitPhaseClosed,
	compactKnowledgeReceiptLedger,
	_internals as ledgerInternals,
	queryLiveMemberships,
	recordPhaseCloseIntent,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const directories: string[] = [];

afterEach(() => {
	while (directories.length) {
		const dir = directories.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function scratch(): string {
	const dir = canonicalMkdtemp('receipt-phase-id-');
	writeFileSync(`${dir}/.git`, 'gitdir: fixture');
	directories.push(dir);
	return dir;
}

const LABEL = 'Phase 2: Implement [IN PROGRESS]';

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

async function seed(dir: string, opts: { phase_id?: number } = {}) {
	const committed = await commitDisplayedMembership(dir, {
		trace_id: 't1',
		session_id: 's1',
		phase: LABEL,
		...(opts.phase_id !== undefined ? { phase_id: opts.phase_id } : {}),
		exposure_kind: 'delegate_directive',
		entries: [{ entry_id: 'e1', critical: true }],
	});
	expect(committed.ok).toBe(true);
	return committed;
}

describe('extractPhaseIdFromLabel Phase 0 guard — regression: no-plan label corrupted the journal (#2947 CI)', () => {
	test('Phase 0 (architect no-plan fallback) parses to undefined, never to id 0', async () => {
		const { extractPhaseIdFromLabel } = await import(
			'../../../src/hooks/extractors.js'
		);
		expect(extractPhaseIdFromLabel('Phase 0')).toBeUndefined();
		expect(extractPhaseIdFromLabel('Phase 2')).toBe(2);
		expect(extractPhaseIdFromLabel(LABEL)).toBe(2);
		expect(extractPhaseIdFromLabel('weird')).toBeUndefined();
	});

	test('a membership committed under the no-plan label Phase 0 stores no phase_id and replays clean', async () => {
		const dir = scratch();
		const committed = await commitDisplayedMembership(dir, {
			trace_id: 't0',
			session_id: 's1',
			phase: 'Phase 0',
			exposure_kind: 'architect_directive',
			entries: [{ entry_id: 'e0', critical: false }],
		});
		expect(committed.ok).toBe(true);
		// Pre-fix this journal read back as store_corrupt (phase_id 0 failed
		// parseMembership's >= 1 check inside the membership_committed record).
		const result = await queryLiveMemberships(dir, { session_id: 's1' });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.memberships[0]?.phase_id).toBeUndefined();
	});
});

describe('phase_id persistence and replay — regression: label-keyed records (#2947)', () => {
	test('explicit phase_id persists through the commit and replays on the next locked read', async () => {
		const dir = scratch();
		await seed(dir, { phase_id: 2 });
		// Every runLocked call re-loads state from the journal, so this query
		// exercises the full parseMembership replay path.
		const result = await queryLiveMemberships(dir, { session_id: 's1' });
		expect(result.ok).toBe(true);
		const membership = result.memberships.find((m) => m.entry_id === 'e1');
		expect(membership?.phase_id).toBe(2);
		expect(membership?.phase).toBe(LABEL);
	});

	test('commit without phase_id stores none (explicit-only persistence)', async () => {
		const dir = scratch();
		await seed(dir);
		const result = await queryLiveMemberships(dir, { session_id: 's1' });
		expect(result.ok).toBe(true);
		expect(result.memberships[0]?.phase_id).toBeUndefined();
	});

	test('the snapshot payload carries phase_id (projection surface)', async () => {
		const dir = scratch();
		await seed(dir, { phase_id: 2 });
		const snapshot = readFileSync(
			join(dir, '.swarm', 'knowledge-receipts-v2.snapshot.json'),
			'utf8',
		);
		expect(snapshot).toContain('"phase_id":2');
	});

	test('the journaled membership_committed record carries phase_id', async () => {
		const dir = scratch();
		await seed(dir, { phase_id: 2 });
		const journal = readFileSync(
			join(dir, '.swarm', 'knowledge-receipts-v2.jsonl'),
			'utf8',
		);
		expect(journal).toContain('"phase_id":2');
		expect(journal).toContain('"kind":"membership_committed"');
	});
});

describe('queryLiveMemberships phase_id filter arms (#2947)', () => {
	test('explicit-id record matches by id even under a skewed filter label', async () => {
		const dir = scratch();
		await seed(dir, { phase_id: 2 });
		const result = await queryLiveMemberships(dir, {
			phase_id: 2,
			session_id: 's1',
		});
		expect(result.ok).toBe(true);
		expect(result.memberships).toHaveLength(1);
	});

	test('id-less record matches through the parsed stored label', async () => {
		const dir = scratch();
		await seed(dir);
		const result = await queryLiveMemberships(dir, {
			phase_id: 2,
			session_id: 's1',
		});
		expect(result.ok).toBe(true);
		expect(result.memberships).toHaveLength(1);
	});

	test('id-less record matches verbatim when the filter label equals the stored label', async () => {
		const dir = scratch();
		await commitDisplayedMembership(dir, {
			trace_id: 't2',
			session_id: 's1',
			phase: 'odd label',
			exposure_kind: 'delegate_directive',
			entries: [{ entry_id: 'e2', critical: false }],
		});
		const result = await queryLiveMemberships(dir, {
			phase: 'odd label',
			phase_id: 7,
			session_id: 's1',
		});
		expect(result.ok).toBe(true);
		expect(result.memberships.map((m) => m.entry_id)).toEqual(['e2']);
	});

	test('a different explicit id never matches by label', async () => {
		const dir = scratch();
		await seed(dir, { phase_id: 3 });
		const result = await queryLiveMemberships(dir, {
			phase: LABEL,
			phase_id: 2,
			session_id: 's1',
		});
		expect(result.ok).toBe(true);
		expect(result.memberships).toHaveLength(0);
	});

	test('no phase_id filter keeps verbatim-only semantics', async () => {
		const dir = scratch();
		await seed(dir, { phase_id: 2 });
		const matching = await queryLiveMemberships(dir, {
			phase: LABEL,
			session_id: 's1',
		});
		expect(matching.ok && matching.memberships).toHaveLength(1);
		const other = await queryLiveMemberships(dir, {
			phase: 'Phase 3: Other [PENDING]',
			session_id: 's1',
		});
		expect(other.ok && other.memberships).toHaveLength(0);
	});
});

describe('phase-close stamping keys on the stable id (#2947)', () => {
	test('close under a skewed label stamps phase_closed_at via the id', async () => {
		const dir = scratch();
		await seed(dir, { phase_id: 2 });
		// Close under a DIFFERENT label but the SAME numeric id — pre-#2947 this
		// fabricated a wrong-label lifecycle and the stamp never landed.
		const closed = await commitPhaseClosed(
			dir,
			'Phase 2: Implement [COMPLETE]',
			's1',
			undefined,
			2,
		);
		expect(closed.ok).toBe(true);
		const result = await queryLiveMemberships(dir, {
			session_id: 's1',
			include_phase_closed: true,
		});
		const membership = result.ok ? result.memberships[0] : undefined;
		expect(membership?.phase_closed_at).toBeDefined();
		expect(membership?.phase_id).toBe(2);
	});

	test('intent and close under different labels land on ONE lifecycle via the id', async () => {
		const dir = scratch();
		await seed(dir);
		const intent = await recordPhaseCloseIntent(
			dir,
			'Phase 2: Implement [IN PROGRESS]',
			's1',
			undefined,
			2,
		);
		expect(intent.ok).toBe(true);
		const closed = await commitPhaseClosed(
			dir,
			'Phase 2: Implement [COMPLETE]',
			's1',
			undefined,
			2,
		);
		expect(closed.ok).toBe(true);
		// Both stamps present on the same membership = one unified lifecycle.
		const result = await queryLiveMemberships(dir, {
			session_id: 's1',
			include_phase_closed: true,
		});
		const membership = result.ok ? result.memberships[0] : undefined;
		expect(membership?.phase_close_intent_at).toBeDefined();
		expect(membership?.phase_closed_at).toBeDefined();
	});
});

describe('wrong_phase reject matches id-first (#2947)', () => {
	test('terminal batch with phase_id and a skewed label commits instead of rejecting', async () => {
		const dir = scratch();
		await seed(dir, { phase_id: 2 });
		const batch = await validateAndCommitTerminalBatch(dir, {
			trace_id: 't1',
			session_id: 's1',
			phase: 'Phase 2: Implement [COMPLETE]',
			phase_id: 2,
			items: [
				{
					entry_id: 'e1',
					outcome: 'applied',
					source: 'reviewer-verdict',
					reason: 'verified applied',
				},
			],
		});
		expect(batch.ok).toBe(true);
		if (batch.ok) {
			expect(batch.rejected).toEqual([]);
			expect(batch.committed.length + batch.idempotent.length).toBe(1);
		}
	});
});

describe('compaction round-trips phase_id through the archive (#2947)', () => {
	test('a compacted archive summary carries phase_id and the audit tail replays', async () => {
		const dir = scratch();
		await seed(dir);
		// Backfill stamps the id and appends a phase_id_backfilled record, which
		// lands in the audit tail; compaction then writes a checkpoint whose
		// audit_tail must include it (parseAuditSummary allowlist coverage).
		const backfill = await backfillMembershipPhaseIds(dir);
		expect(backfill.ok).toBe(true);
		if (backfill.ok) expect(backfill.backfilled).toBe(1);
		// Force compaction eligibility: close the phase (with the id) and age
		// the membership past its grace window.
		await validateAndCommitTerminalBatch(dir, {
			trace_id: 't1',
			session_id: 's1',
			phase: LABEL,
			phase_id: 2,
			items: [{ entry_id: 'e1', outcome: 'applied', source: 'test' }],
		});
		await commitPhaseClosed(dir, LABEL, 's1', undefined, 2);
		const originalNow = ledgerInternals.nowMs;
		try {
			ledgerInternals.nowMs = () => originalNow() + 8 * 86_400_000;
			// compactKnowledgeReceiptLedger takes the lock WITH compaction
			// enabled (queries disable it), so the aged clock applies here.
			const compacted = await compactKnowledgeReceiptLedger(dir);
			expect(compacted.ok).toBe(true);
		} finally {
			ledgerInternals.nowMs = originalNow;
		}
		const archive = join(dir, '.swarm', 'knowledge-receipts-v2-archive.jsonl');
		const archived = readFileSync(archive, 'utf8');
		expect(archived).toContain('"phase_id":2');
		// Post-compaction reads must not report store_corrupt (the checkpoint
		// record's audit tail contains the phase_id_backfilled summary).
		const after = await queryLiveMemberships(dir, {
			session_id: 's1',
			include_phase_closed: true,
		});
		expect(after.ok).toBe(true);
	}, 20_000);
});

describe('backfill replay skip-on-missing (#2947, plan-critic F11)', () => {
	test('backfill over a fully-backfilled store appends nothing', async () => {
		const dir = scratch();
		await seed(dir, { phase_id: 2 });
		const linesBefore = journalLines(dir);
		const backfill = await backfillMembershipPhaseIds(dir);
		expect(backfill.ok).toBe(true);
		if (backfill.ok) {
			expect(backfill.backfilled).toBe(0);
			expect(backfill.journal_records).toBe(0);
		}
		expect(journalLines(dir)).toBe(linesBefore);
	});

	test('a phase_id_backfilled item naming an absent membership is tolerated on replay', async () => {
		const dir = scratch();
		// One live row without an id (the item below will name a PRESENT
		// target and an ABSENT target in the same record).
		await commitDisplayedMembership(dir, {
			trace_id: 't1',
			session_id: 's1',
			phase: LABEL,
			exposure_kind: 'delegate_directive',
			entries: [{ entry_id: 'e1', critical: true }],
		});
		// Hand-append a validly hash-chained phase_id_backfilled record whose
		// items cover both cases: {t1,e1} exists; {t-gone,e-gone} does not.
		const journalPath = join(dir, '.swarm', 'knowledge-receipts-v2.jsonl');
		const lines = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean);
		const last = JSON.parse(lines[lines.length - 1]);
		const record = {
			schema_version: 2,
			cutover_version: 1,
			seq: last.seq + 1,
			prev_hash: last.hash,
			event_id: randomUUID(),
			// Reuse the prior record's timestamp (deterministic; no real clock).
			timestamp: last.timestamp,
			kind: 'phase_id_backfilled',
			payload: {
				items: [
					{ trace_id: 't1', entry_id: 'e1', phase_id: 2 },
					{ trace_id: 't-gone', entry_id: 'e-gone', phase_id: 2 },
				],
			},
		};
		const { receiptRecordHash } = await import(
			'../../../src/hooks/knowledge-receipt-ledger-storage.js'
		);
		const hash = receiptRecordHash(record);
		appendFileSync(journalPath, `${JSON.stringify({ ...record, hash })}\n`);

		// Replay must tolerate the absent target: no throw, no store_corrupt.
		const result = await queryLiveMemberships(dir, { session_id: 's1' });
		expect(result.ok).toBe(true);
		if (result.ok) {
			// Present target applied; absent target creates no phantom row.
			expect(result.memberships).toHaveLength(1);
			expect(result.memberships[0]?.entry_id).toBe('e1');
			expect(result.memberships[0]?.phase_id).toBe(2);
		}
		// Second replay is a no-op (idempotent application).
		const again = await queryLiveMemberships(dir, { session_id: 's1' });
		expect(again.ok).toBe(true);
		if (again.ok) expect(again.memberships[0]?.phase_id).toBe(2);
	});
});
