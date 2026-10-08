/**
 * Issue #3097 (AC6 rider): the `abort_pr_workflow` tool description must
 * disclose the bounded `reason` length cap — "(max 500 chars)" — so an
 * architect invoking the recovery escape hatch knows an over-long reason is
 * refused before the gate clears and a post-abort export becomes necessary.
 */
import { expect, test } from 'bun:test';
import { abort_pr_workflow } from '../../../src/tools/abort-pr-workflow.js';

test('abort_pr_workflow description discloses the reason cap "(max 500 chars)" (issue #3097)', () => {
	expect(abort_pr_workflow.description).toContain('(max 500 chars)');
});
