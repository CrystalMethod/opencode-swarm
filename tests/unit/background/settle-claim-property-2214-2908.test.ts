/**
 * #2214 ledger-layer property (issue #2908, AC3) — fast-check over the REAL
 * delegation store.
 *
 * After the terminal-claim primitive records a terminal, no interleaving of
 * duplicate replay, conflicting terminal, or re-read can leave the
 * correlation folding to a non-terminal status: the claimed status and typed
 * terminal identity survive every subsequent operation. This is the ledger
 * layer's expression of the #2214 wedge shape ("settlement never finalizes");
 * the DISPATCHED-WAL incident surface itself is the coder-settlement WAL,
 * pinned by tests/unit/workflow/coder-settlement-2214.test.ts — see the
 * wedge-shape layer map in docs/pr-review-transition-authority.md.
 *
 * Runs are batched over rotating temp project roots (fresh root every 25 runs)
 * so each fold stays small.
 *
 * RUN COUNT (400, deliberately not 1000): every run drives the real store on
 * disk against a CI per-test budget of 120 s. At 1000 runs this measured 87 s
 * wall — passing, but with little margin, and the sibling restart property
 * timed out outright at the same setting under host load. 400 runs keeps ~3x
 * margin while still covering 400 independent interleavings of a real ledger.
 * The frozen C3 contract binds numRuns >= 1000 to the REDUCER property file
 * (tests/unit/pr-review/settle-invariants-2908.test.ts), which is pure
 * in-memory; these real-disk siblings are not bound by it. Do not raise this
 * without re-measuring against the CI budget, not just against one local run.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import fc from 'fast-check';
import { settleDelegationTerminal } from '../../../src/background/delegation-lifecycle.js';
import {
	readDelegationsDetailed,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

let runCounter = 0;

/** Pinned so a #2214 property failure is reproducible from the run alone. */
const PROPERTY_SEED = 2908;

function terminalInput(
	status: 'completed' | 'error' | 'cancelled' | 'stale',
	nonce: string,
) {
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

describe('settlement claim property, ledger layer (issue #2908, #2214)', () => {
	const dirs: string[] = [];
	let current: string | null = null;
	let uses = 0;
	const nextDir = (): string => {
		if (current === null || uses >= 25) {
			const dir = canonicalMkdtemp('settle-claim-2214-');
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
		for (const dir of dirs.splice(0)) removeTreeWithRetry(dir);
	});

	test('a claimed terminal is never lost, overwritten, or re-opened by any interleaving', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom('completed', 'error', 'cancelled'),
				fc.constantFrom('error', 'cancelled', 'stale'),
				fc.boolean(),
				async (claimStatus, conflictStatus, replayFirst) => {
					const dir = nextDir();
					runCounter += 1;
					const id = `claim-${runCounter}`;
					const pending = await recordPendingDelegation(dir, {
						correlationId: id,
						jobId: null,
						subagentSessionId: id,
						parentSessionId: 'ses-2214',
						callID: `call-${id}`,
						normalizedAgent: 'reviewer',
						swarmPrefixedAgent: 'swarm_reviewer',
						planTaskId: null,
						evidenceTaskId: null,
					});
					expect(pending, `record creation failed for ${id}`).not.toBeNull();
					const first = await settleDelegationTerminal(
						dir,
						pending!,
						terminalInput(claimStatus, `${id}-0`),
						{},
						runCounter,
					);
					expect(first.kind).toBe('claimed');
					if (replayFirst) {
						const replay = await settleDelegationTerminal(
							dir,
							first.kind === 'claimed' ? first.record : pending!,
							terminalInput(claimStatus, `${id}-0`),
							{},
							runCounter,
						);
						expect(replay.kind).toBe('duplicate');
					}
					const terminalRecord =
						first.kind === 'claimed' ? first.record : pending!;
					const conflicting = await settleDelegationTerminal(
						dir,
						terminalRecord,
						terminalInput(conflictStatus, `${id}-conflict`),
						{},
						runCounter,
					);
					expect(['conflict', 'already_terminal_without_event']).toContain(
						conflicting.kind,
					);
					const after = readDelegationsDetailed(dir).records.find(
						(record) => record.correlationId === id,
					);
					expect(after, `fold lost ${id}`).toBeDefined();
					if (!after) return;
					expect(after.status, id).toBe(claimStatus);
					expect(after.terminalResult?.status, id).toBe(claimStatus);
					expect(after.terminalResult?.eventId, id).toBe(
						terminalRecord.terminalResult?.eventId,
					);
				},
			),
			{ numRuns: 400, seed: PROPERTY_SEED },
		);
	}, 120_000);
});
