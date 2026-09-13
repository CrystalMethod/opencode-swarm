import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	resetArchitectPromptBudgetAdvisories,
	warnArchitectPromptBudgetExceededOnce,
} from '../../../src/agents/architect';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';

/**
 * Pins the once-per-process-per-error dedup of
 * warnArchitectPromptBudgetExceededOnce (issue #2671 review PRR-102) and its
 * session-start reset contract (resetArchitectPromptBudgetAdvisories, wired
 * next to clearDeferredWarnings in src/index.ts so a fixed-then-reintroduced
 * config warns again in a new session).
 */

const ERROR_A = 'ARCHITECT_PROMPT_BUDGET_EXCEEDED: cell-a 162000 chars';
const ERROR_B = 'ARCHITECT_PROMPT_BUDGET_EXCEEDED: cell-b 163000 chars';

describe('architect budget advisory dedup (#2671 review)', () => {
	beforeEach(() => {
		clearDeferredWarnings();
		resetArchitectPromptBudgetAdvisories();
	});

	afterEach(() => {
		resetArchitectPromptBudgetAdvisories();
	});

	test('identical error text warns exactly once; distinct text warns again', () => {
		warnArchitectPromptBudgetExceededOnce(ERROR_A);
		warnArchitectPromptBudgetExceededOnce(ERROR_A);
		warnArchitectPromptBudgetExceededOnce(ERROR_A);
		expect(
			getDeferredWarnings().filter((w) => w === ERROR_A),
			'identical bounded error must emit exactly one advisory',
		).toHaveLength(1);

		warnArchitectPromptBudgetExceededOnce(ERROR_B);
		expect(
			getDeferredWarnings().some((w) => w === ERROR_B),
			'a distinct error (different label/lengths) must not be suppressed',
		).toBe(true);
	});

	test('reset re-enables emission for the same error (new-session contract)', () => {
		warnArchitectPromptBudgetExceededOnce(ERROR_A);
		expect(getDeferredWarnings().filter((w) => w === ERROR_A)).toHaveLength(1);

		resetArchitectPromptBudgetAdvisories();
		clearDeferredWarnings();
		warnArchitectPromptBudgetExceededOnce(ERROR_A);
		expect(
			getDeferredWarnings().filter((w) => w === ERROR_A),
			'after the session-start reset the same config must warn again',
		).toHaveLength(1);
	});
});
