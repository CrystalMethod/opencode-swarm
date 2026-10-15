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
 * so each fold stays small while the property still covers 1000 independent
 * interleavings within the CI per-file budget.
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
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let runCounter = 0;

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
		for (const dir of dirs.splice(0)) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Windows EBUSY on cleanup is environmental.
			}
		}
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
			{ numRuns: 1000 },
		);
	}, 120_000);
});
