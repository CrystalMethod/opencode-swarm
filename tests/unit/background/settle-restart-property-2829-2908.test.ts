/**
 * #2829 ledger/checkpoint-layer property (issue #2908, AC3) — fast-check over
 * the REAL delegation store.
 *
 * Claimed terminals survive a restart-fold: after claims land, a fresh fold
 * (the reader a restarted process performs) reports the same terminal set,
 * and a real forced compaction (issue #2034 checkpoint+tail) preserves status,
 * typed-terminal status, and eventId identity. This is the ledger layer's
 * expression of the #2829 wedge shape ("terminal lost on restart"); the
 * binding-store incident surface is exercised by the wedge reproduction in
 * settle-wedge-shapes-2908.test.ts — see the wedge-shape layer map in
 * docs/pr-review-transition-authority.md.
 *
 * Batches rotate every 15 runs; compaction fires on every 5th run so both the
 * legacy fold and the checkpoint+tail fold are exercised at scale while the
 * property stays inside the CI per-file budget.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import fc from 'fast-check';
import { settleDelegationTerminal } from '../../../src/background/delegation-lifecycle.js';
import {
	compactBackgroundDelegations,
	readDelegationsDetailed,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let runCounter = 0;

function terminalInput(status: 'completed' | 'error', nonce: string) {
	const text = `payload-${nonce}`;
	return {
		status,
		result: {
			text,
			chars: text.length,
			truncated: false,
			digest: `digest-${nonce}`,
		},
	} as const;
}

describe('settlement restart property, ledger/checkpoint layer (issue #2908, #2829)', () => {
	const dirs: string[] = [];
	let current: string | null = null;
	let uses = 0;
	const nextDir = (): string => {
		if (current === null || uses >= 15) {
			const dir = canonicalMkdtemp('settle-restart-2829-');
			fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
			fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			dirs.push(dir);
			current = dir;
			uses = 0;
		}
		uses += 1;
		return current;
	};
	afterAll(() => {
		for (const dir of dirs.splice(0)) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Windows EBUSY on cleanup is environmental.
			}
		}
	});

	test('claimed terminals survive a restart-fold across real compaction', async () => {
		const expected = new Map<string, { status: string; eventId: string }>();
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 2 }),
				fc.constantFrom('completed', 'error'),
				async (extraRecords, status) => {
					const dir = nextDir();
					const ids: string[] = [];
					for (let i = 0; i < extraRecords; i += 1) {
						runCounter += 1;
						const id = `restart-${runCounter}`;
						ids.push(id);
						const pending = await recordPendingDelegation(dir, {
							correlationId: id,
							jobId: null,
							subagentSessionId: id,
							parentSessionId: 'ses-2829',
							callID: `call-${id}`,
							normalizedAgent: 'reviewer',
							swarmPrefixedAgent: 'swarm_reviewer',
							planTaskId: null,
							evidenceTaskId: null,
						});
						expect(pending, `record creation failed for ${id}`).not.toBeNull();
						const claimed = await settleDelegationTerminal(
							dir,
							pending!,
							terminalInput(status, `${id}-t`),
							{},
							runCounter,
						);
						expect(claimed.kind).toBe('claimed');
						if (claimed.kind === 'claimed') {
							expected.set(id, {
								status,
								eventId: claimed.record.terminalResult.eventId,
							});
						}
					}
					if (runCounter % 5 === 0) {
						const compact = await compactBackgroundDelegations(dir, {
							force: true,
						});
						expect(compact.status).toBe('compacted');
					}
					const outcome = readDelegationsDetailed(dir);
					expect(outcome.status).toBe('ok');
					if (outcome.status !== 'ok') return;
					const folded = new Map(
						outcome.records.map((record) => [record.correlationId, record]),
					);
					for (const id of ids) {
						const want = expected.get(id)!;
						const record = folded.get(id);
						expect(record, `restart-fold lost ${id}`).toBeDefined();
						if (!record) continue;
						expect(record.status, id).toBe(want.status);
						expect(record.terminalResult?.status, id).toBe(want.status);
						expect(record.terminalResult?.eventId, id).toBe(want.eventId);
					}
				},
			),
			{ numRuns: 1000 },
		);
	}, 120_000);
});
