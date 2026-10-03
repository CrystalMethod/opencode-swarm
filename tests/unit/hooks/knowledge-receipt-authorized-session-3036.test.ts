/**
 * Issue #3036 — ledger-side authorized filing: a child session attested by
 * dispatch lineage may file its architect's stamp (role-matched); every other
 * mismatch stays fail-closed wrong_session with the out-of-band stamp map.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	commitDisplayedMembership,
	type ReceiptLedgerResult,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const ARCH = 'ses-arch-3036-led';
const CHILD = 'ses-child-3036-led';
const FOREIGN = 'ses-foreign-3036-led';

function unwrap<T>(result: ReceiptLedgerResult<T>): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
	return result;
}

describe('knowledge receipt authorized filing (issue #3036)', () => {
	let directory: string;
	let cleanup: () => void;
	const trace = 'trace-3036-led';
	const entry = 'entry-3036-led';

	beforeEach(async () => {
		const fixture = createSafeTestDir('receipt-authorized-3036-');
		directory = fixture.dir;
		cleanup = fixture.cleanup;
		fs.mkdirSync(path.join(directory, '.git'));
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: trace,
				session_id: ARCH,
				exposure_kind: 'delegate_directive',
				task_id: '2.3',
				agent: 'reviewer',
				entries: [{ entry_id: entry, critical: true, rank: 1, score: 1 }],
			}),
		);
	});
	afterEach(() => {
		cleanup();
	});

	test('authorized child filing (role match) is accepted', async () => {
		const committed = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: CHILD,
				task_id: '2.3',
				agent: 'reviewer',
				authorized_filing_sessions: [CHILD, ARCH],
				items: [{ entry_id: entry, outcome: 'applied' }],
			}),
		);
		expect(committed.rejected).toEqual([]);
		expect(committed.accepted).toHaveLength(1);
	});

	test('unauthorized same-role filer (no lineage attestation) stays wrong_session with the out-of-band stamp map', async () => {
		const committed = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: FOREIGN,
				task_id: '2.3',
				agent: 'reviewer',
				items: [{ entry_id: entry, outcome: 'applied' }],
			}),
		);
		// Byte-identical rejected item shape (C4 fence pin).
		expect(committed.rejected).toEqual([
			{ entry_id: entry, reason: 'wrong_session' },
		]);
		expect(committed.wrong_session_membership_sessions).toEqual({
			[entry]: ARCH,
		});
	});

	test('lineage attestation does NOT override a role mismatch (fail-closed)', async () => {
		const committed = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: CHILD,
				task_id: '2.3',
				agent: 'test_engineer',
				authorized_filing_sessions: [CHILD, ARCH],
				items: [{ entry_id: entry, outcome: 'applied' }],
			}),
		);
		expect(committed.rejected).toEqual([
			{ entry_id: entry, reason: 'wrong_session' },
		]);
	});

	test('prefixed agent names normalize for the role match', async () => {
		const committed = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: CHILD,
				task_id: '2.3',
				agent: 'swarm1_reviewer',
				authorized_filing_sessions: [CHILD, ARCH],
				items: [{ entry_id: entry, outcome: 'applied' }],
			}),
		);
		expect(committed.rejected).toEqual([]);
	});

	test('empty/whitespace authorized entries are ignored (sanitization)', async () => {
		const committed = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: CHILD,
				task_id: '2.3',
				agent: 'reviewer',
				authorized_filing_sessions: ['', '   ', CHILD],
				items: [{ entry_id: entry, outcome: 'applied' }],
			}),
		);
		expect(committed.rejected).toEqual([
			{ entry_id: entry, reason: 'wrong_session' },
		]);
	});

	test('same-session filing needs no attestation (legacy callers unchanged)', async () => {
		const committed = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: ARCH,
				task_id: '2.3',
				agent: 'reviewer',
				items: [{ entry_id: entry, outcome: 'applied' }],
			}),
		);
		expect(committed.rejected).toEqual([]);
	});
});
