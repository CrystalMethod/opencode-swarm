/**
 * Ingestion journey (issue #2564), part 2: gates ladder → handoff → published
 * → merge_approval_recorded (PR-head bound, recorded never certified). Real
 * machinery only. Under 500 lines (FR-006).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	createJourneyProject,
	handleIssueCommand,
	PR_HEAD,
} from './issue-trace-journey-v3-helpers';

let project: ReturnType<typeof createJourneyProject> | null = null;
afterEach(() => {
	project?.cleanup();
	project = null;
});

/** Drives the journey through EXECUTE (phases complete), returning the project. */
async function journeyThroughExecute() {
	const p = createJourneyProject();
	handleIssueCommand(p.dir, ['ZaxbyHub/opencode-swarm#2564', '--trace']);
	p.writeSpec();
	return p;
}

describe('issue-ingestion journey v3 — gates through merge approval', () => {
	test('review gate surfaces the actionable directive before the receipt lands', async () => {
		project = await journeyThroughExecute();
		await project.recordFreshness();
		await project.recordRepro();
		await project.cycle();
		await project.saveJourneyPlan('in_progress', 'in_progress');
		await project.approveCritic();
		await project.cycle(); // EXECUTE
		await project.saveJourneyPlan('complete', 'completed');

		const step = await project.cycle();
		expect(step.state.lastTransition).toBe('REVIEW_GATE');
		expect(step.text).toMatch(/implementation review/i);
	});

	test('full ladder: handoff → published → merge_approval_recorded with PR-head binding', async () => {
		project = await journeyThroughExecute();
		await project.recordFreshness();
		await project.recordRepro();
		await project.cycle();
		await project.saveJourneyPlan('in_progress', 'in_progress');
		await project.approveCritic();
		await project.cycle(); // EXECUTE
		await project.saveJourneyPlan('complete', 'completed');

		await project.cycle(); // REVIEW_GATE one-shot
		const review = await project.recordReview();
		expect(review.success).toBe(true);

		await project.cycle(); // RECURRENCE_GATE one-shot
		const sweep = await project.recordSweep();
		expect(sweep.success).toBe(true);

		await project.cycle(); // TRACE_VALIDATION_GATE one-shot
		const validation = await project.recordValidation();
		expect(validation.success).toBe(true);

		// Handoff: publication_handoff + commit-pr directive.
		const handoff = await project.cycle();
		expect(handoff.state.lastTransition).toBe('EXECUTE_TO_COMMIT');
		expect(handoff.state.status).toBe('publication_handoff');
		expect(handoff.text).toMatch(/commit-pr|publication/i);

		const publication = await project.recordPublication();
		expect(publication.success).toBe(true);

		const published = await project.cycle();
		expect(published.state.status).toBe('published');
		expect(published.state.lastTransition).toBe('PUBLISHED');

		const merge = await project.recordMergeApproval();
		expect(merge.success).toBe(true);

		const recorded = await project.cycle();
		expect(recorded.state.status).toBe('merge_approval_recorded');
		expect(recorded.state.lastTransition).toBe('MERGE_APPROVAL_RECORDED');
		// Recorded, never certified: no mode is driven.
		expect(recorded.text).toMatch(/human/i);
		expect(recorded.text).not.toMatch(/\[MODE:/);

		// PR-head binding across receipts.
		const mergeReceipt = JSON.parse(
			fs.readFileSync(
				path.join(project.dir, '.swarm', 'merge-approval.json'),
				'utf-8',
			),
		);
		const pubReceipt = JSON.parse(
			fs.readFileSync(
				path.join(project.dir, '.swarm', 'issue-publication.json'),
				'utf-8',
			),
		);
		expect(mergeReceipt.prHeadSha).toBe(PR_HEAD);
		expect(pubReceipt.headSha).toBe(PR_HEAD);

		// All v3 receipts durably on disk.
		for (const name of [
			'branch-freshness.json',
			'trace-validation.json',
			'merge-approval.json',
		]) {
			expect(fs.existsSync(path.join(project.dir, '.swarm', name))).toBe(true);
		}
	});
});
