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
 * Batches rotate every 15 runs; compaction fires on every 5th RUN — the
 * cadence is keyed off the run index, not the record counter (which advances
 * by the generated extraRecords) — so both the legacy fold and the
 * checkpoint+tail fold are exercised at scale while the property stays inside
 * the CI per-file budget. Every forced compaction must publish a durable
 * checkpoint file. The expectation set is PER-ROTATED-DIR and cumulative:
 * after every fold, the FULL accumulated id -> terminal set for that dir is
 * re-asserted, so a compaction that evicts an earlier record in the same
 * rotating dir fails immediately. The property runs under a pinned fast-check
 * seed so a CI counterexample reproduces exactly.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import fc from 'fast-check';
import { settleDelegationTerminal } from '../../../src/background/delegation-lifecycle.js';
import {
	BACKGROUND_DELEGATIONS_CHECKPOINT_FILE,
	compactBackgroundDelegations,
	readDelegationsDetailed,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const PROPERTY_SEED = 2908;
const ROTATE_EVERY_RUNS = 15;
const COMPACT_EVERY_RUNS = 5;

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
	// Per-rotated-dir accumulated expectation: correlationId -> the exact
	// terminal identity the claim established. Asserted IN FULL after every
	// fold, so eviction of any earlier record in this dir fails at once.
	const expectedByDir = new Map<
		string,
		Map<string, { status: string; eventId: string }>
	>();
	let current: string | null = null;
	let uses = 0;
	const nextDir = (): string => {
		if (current === null || uses >= ROTATE_EVERY_RUNS) {
			const dir = canonicalMkdtemp('settle-restart-2829-');
			fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
			fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			dirs.push(dir);
			expectedByDir.set(dir, new Map());
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
		// The run index keys both the compaction cadence and the record ids; a
		// mutable module counter would drift under generator re-runs.
		let runIndex = 0;
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 2 }),
				fc.constantFrom('completed', 'error'),
				async (extraRecords, status) => {
					runIndex += 1;
					const dir = nextDir();
					const expected = expectedByDir.get(dir)!;
					for (let i = 0; i < extraRecords; i += 1) {
						const id = `restart-${runIndex}-${i}`;
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
							runIndex * 10 + i,
						);
						expect(claimed.kind, `claim failed for ${id}`).toBe('claimed');
						if (claimed.kind === 'claimed') {
							expected.set(id, {
								status,
								eventId: claimed.record.terminalResult.eventId,
							});
						}
					}
					// Cadence keyed off the RUN index: every 5th run forces the
					// real compaction and must publish its durable checkpoint.
					if (runIndex % COMPACT_EVERY_RUNS === 0) {
						const compact = await compactBackgroundDelegations(dir, {
							force: true,
						});
						expect(compact.status, `compaction at run ${runIndex}`).toBe(
							'compacted',
						);
						expect(
							fs.existsSync(
								path.join(
									dir,
									'.swarm',
									BACKGROUND_DELEGATIONS_CHECKPOINT_FILE,
								),
							),
							`compaction at run ${runIndex} must publish a checkpoint`,
						).toBe(true);
					}
					const outcome = readDelegationsDetailed(dir);
					expect(outcome.status).toBe('ok');
					if (outcome.status !== 'ok') return;
					const folded = new Map(
						outcome.records.map((record) => [record.correlationId, record]),
					);
					// The FULL accumulated set for THIS rotated dir — not just the
					// current run's ids — so an eviction or loss of any earlier
					// record in the dir fails at the very next fold.
					for (const [id, want] of expected) {
						const record = folded.get(id);
						expect(record, `restart-fold lost ${id} in ${dir}`).toBeDefined();
						if (!record) continue;
						expect(record.status, id).toBe(want.status);
						expect(record.terminalResult?.status, id).toBe(want.status);
						expect(record.terminalResult?.eventId, id).toBe(want.eventId);
					}
				},
			),
			{ numRuns: 1000, seed: PROPERTY_SEED },
		);
	}, 120_000);
});
