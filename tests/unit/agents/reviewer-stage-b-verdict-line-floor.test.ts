// Issue #3310 AC7 — PRESERVING floor: the Stage-B structured verdict line
// survives outside PR-review mode.
//
// The PR-review reviewer lane (issue #3310 AC6) disclaims the Stage-B
// 'STRUCTURED VERDICT LINE' mandate inside its controller-owned contract —
// that is a mode-scoped PR-review change ONLY. The base reviewer agent prompt
// keeps the mandate (task-keyed [REVIEWED] rows), and the Stage-B consumer in
// src/background/stage-b-gates.ts (structuredStageBVerdict — module-private,
// not exported, so it is exercised here as the identical role-based pattern)
// keeps matching those rows. This check is green at base and after the fix.
import { describe, expect, test } from 'bun:test';
import { createReviewerAgent } from '../../../src/agents/reviewer.js';

/**
 * Mirrors the reviewer branch of structuredStageBVerdict in
 * src/background/stage-b-gates.ts: applied here to the agent prompt's example
 * rows to prove the prompt's shipped examples satisfy the Stage-B matcher
 * shape for a concrete taskId.
 */
const stageBReviewerRowPattern = (taskId: string): RegExp => {
	const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(
		`^\\[REVIEWED\\]\\s*\\|\\s*(?:task-)?${escapedTaskId}\\s*\\|\\s*(APPROVED|REJECTED|CONCERNS)\\s*\\|`,
		'im',
	);
};

describe('reviewer Stage-B verdict line floor (issue #3310 AC7)', () => {
	test('the base reviewer prompt keeps the STRUCTURED VERDICT LINE mandate and task-keyed examples', () => {
		const prompt = createReviewerAgent('model-x').config.prompt ?? '';
		expect(prompt).toContain('## STRUCTURED VERDICT LINE (MANDATORY)');
		expect(prompt).toContain('[REVIEWED] | task-');
	});

	test('the structured-findings reviewer variant keeps the mandate too', () => {
		const prompt =
			createReviewerAgent('model-x', undefined, undefined, true).config
				.prompt ?? '';
		expect(prompt).toContain('## STRUCTURED VERDICT LINE (MANDATORY)');
		expect(prompt).toContain('[REVIEWED] | task-');
	});

	test("the prompt example row satisfies the Stage-B matcher shape for taskId '2.1'", () => {
		const prompt = createReviewerAgent('model-x').config.prompt ?? '';
		expect(stageBReviewerRowPattern('2.1').test(prompt)).toBe(true);
	});
});
