import { afterEach, describe, expect, it } from 'bun:test';
import {
	beginTurnLedger,
	claimTurnBudget,
	claimTurnBudgetWithReceipt,
	clearTurnLedger,
	commitInjectionBudgetReceipt,
	getTurnLedgerSummary,
	recordProducerEmission,
	recordProducerGrantWithReceipt,
	refundInjectionBudgetReceipt,
} from '../../../src/services/injection-budget.js';

const SESSION_A = 'session-a';

afterEach(() => {
	clearTurnLedger(SESSION_A);
});

describe('opaque turn-budget reservation receipts', () => {
	it('refunds only its deltas when two receipts share one producer', () => {
		const generation = beginTurnLedger(SESSION_A, 500, true);
		const first = recordProducerGrantWithReceipt(
			SESSION_A,
			'system-enhancer',
			30,
			20,
			'messages',
			{
				expectedGeneration: generation,
				retractEmissionOnRefund: true,
				emittedTokensOnRefund: 8,
			},
		);
		recordProducerEmission(SESSION_A, 'system-enhancer', 8, 0, 'messages', {
			expectedGeneration: generation,
		});
		const second = recordProducerGrantWithReceipt(
			SESSION_A,
			'system-enhancer',
			40,
			25,
			'messages',
			{
				expectedGeneration: generation,
				retractEmissionOnRefund: true,
				emittedTokensOnRefund: 12,
			},
		);
		recordProducerEmission(SESSION_A, 'system-enhancer', 12, 0, 'messages', {
			expectedGeneration: generation,
		});

		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(refundInjectionBudgetReceipt(first!)).toBe(true);
		const afterFirstRefund = getTurnLedgerSummary(SESSION_A);
		expect(afterFirstRefund?.used).toBe(25);
		expect(afterFirstRefund?.producers[0]).toMatchObject({
			requested: 40,
			granted: 25,
			emitted: 12,
			truncated: 8,
			surface: 'messages',
		});
		expect(refundInjectionBudgetReceipt(first!)).toBe(false);
		expect(getTurnLedgerSummary(SESSION_A)).toEqual(afterFirstRefund);
	});

	it('preserves a committed system-surface receipt while refunding an unrelated message claim', () => {
		beginTurnLedger(SESSION_A, 500, true);
		const systemReceipt = recordProducerGrantWithReceipt(
			SESSION_A,
			'memory-recall',
			20,
			15,
			'system',
		);
		recordProducerEmission(SESSION_A, 'memory-recall', 9, 0, 'system');
		const messageClaim = claimTurnBudgetWithReceipt(
			SESSION_A,
			'guidance-carrier-fence',
			11,
			{ localMaxTokens: 11, surface: 'messages' },
		);
		expect(systemReceipt).toBeDefined();
		expect(messageClaim.receipt).toBeDefined();
		expect(commitInjectionBudgetReceipt(systemReceipt!)).toBe(true);

		const systemBeforeRefund = getTurnLedgerSummary(SESSION_A)?.producers.find(
			(entry) => entry.producer === 'memory-recall',
		);
		expect(refundInjectionBudgetReceipt(messageClaim.receipt!)).toBe(true);
		const summary = getTurnLedgerSummary(SESSION_A);
		expect(
			summary?.producers.find((entry) => entry.producer === 'memory-recall'),
		).toEqual(systemBeforeRefund);
		expect(
			summary?.producers.some(
				(entry) => entry.producer === 'guidance-carrier-fence',
			),
		).toBe(false);
		expect(summary?.used).toBe(15);
	});

	it('makes commit and refund one-shot and idempotent', () => {
		beginTurnLedger(SESSION_A, 100, true);
		const committed = claimTurnBudgetWithReceipt(
			SESSION_A,
			'memory-recall',
			10,
			{ surface: 'messages' },
		).receipt!;
		expect(commitInjectionBudgetReceipt(committed)).toBe(true);
		const afterCommit = getTurnLedgerSummary(SESSION_A);
		expect(commitInjectionBudgetReceipt(committed)).toBe(false);
		expect(refundInjectionBudgetReceipt(committed)).toBe(false);
		expect(getTurnLedgerSummary(SESSION_A)).toEqual(afterCommit);

		const refunded = claimTurnBudgetWithReceipt(
			SESSION_A,
			'guidance-carrier-fence',
			12,
			{ surface: 'messages' },
		).receipt!;
		expect(refundInjectionBudgetReceipt(refunded)).toBe(true);
		const afterRefund = getTurnLedgerSummary(SESSION_A);
		expect(refundInjectionBudgetReceipt(refunded)).toBe(false);
		expect(commitInjectionBudgetReceipt(refunded)).toBe(false);
		expect(getTurnLedgerSummary(SESSION_A)).toEqual(afterRefund);
	});

	it('does not settle a receipt from a replaced generation or stale surface', () => {
		const oldGeneration = beginTurnLedger(SESSION_A, 100, true);
		const oldReceipt = claimTurnBudgetWithReceipt(
			SESSION_A,
			'memory-recall',
			20,
			{ surface: 'messages' },
		).receipt!;
		beginTurnLedger(SESSION_A, 100, true);
		claimTurnBudget(SESSION_A, 'context-capsule', 7, {
			localMaxTokens: 7,
			surface: 'system',
		});
		const replacementLedger = getTurnLedgerSummary(SESSION_A);
		expect(oldGeneration).toBeLessThan(replacementLedger!.generation);
		expect(refundInjectionBudgetReceipt(oldReceipt)).toBe(false);
		expect(commitInjectionBudgetReceipt(oldReceipt)).toBe(false);
		expect(getTurnLedgerSummary(SESSION_A)).toEqual(replacementLedger);

		const currentReceipt = claimTurnBudgetWithReceipt(
			SESSION_A,
			'system-enhancer',
			13,
			{ surface: 'messages' },
		).receipt!;
		recordProducerEmission(SESSION_A, 'system-enhancer', 5, 0, 'system');
		const changedSurface = getTurnLedgerSummary(SESSION_A);
		expect(refundInjectionBudgetReceipt(currentReceipt)).toBe(false);
		expect(getTurnLedgerSummary(SESSION_A)).toEqual(changedSurface);
	});
});
