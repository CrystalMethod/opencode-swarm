import { afterEach, describe, expect, test } from 'bun:test';
import { createRoleFilterSystemHook } from '../../src/context/role-filter';
import {
	beginTurnLedger,
	clearTurnLedger,
	getTurnLedgerSummary,
	recordProducerEmission,
} from '../../src/services/injection-budget';

const SESSION_ID = 'issue-2780-generation-interleave';

describe('architect delayed delivery generation binding (FB-026)', () => {
	afterEach(() => clearTurnLedger(SESSION_ID));

	test('a same-session replacement during role filtering is untouched by the old delivery', async () => {
		const oldGeneration = beginTurnLedger(SESSION_ID, 100, true);
		recordProducerEmission(SESSION_ID, 'system-enhancer', 40, 0, 'system', {
			expectedGeneration: oldGeneration,
		});
		const roleFilter = createRoleFilterSystemHook(() => undefined);
		let replacementGeneration: number | undefined;
		let replacementBeforeDelivery: ReturnType<typeof getTurnLedgerSummary> =
			null;
		const delayedDeliveryInput = {
			sessionID: SESSION_ID,
			expectedGeneration: oldGeneration,
			get agent(): string {
				// Simulate a concurrent composition replacing the ledger while this
				// older delivery is resolving its role-filter target.
				replacementGeneration = beginTurnLedger(SESSION_ID, 100, true);
				recordProducerEmission(SESSION_ID, 'system-enhancer', 11, 0, 'system', {
					expectedGeneration: replacementGeneration,
				});
				replacementBeforeDelivery = getTurnLedgerSummary(SESSION_ID);
				return 'coder';
			},
		};

		await roleFilter['experimental.chat.system.transform'](
			delayedDeliveryInput,
			{ system: ['[FOR: reviewer] Delayed architect-only context.'] },
		);

		expect(replacementGeneration).toBeGreaterThan(oldGeneration);
		expect(getTurnLedgerSummary(SESSION_ID)).toEqual(replacementBeforeDelivery);
	});
});
