/**
 * Issue #2898 workflow-shape guard: every `run:` step that invokes
 * scripts/release-notes-fragments.mjs with a mode whose execution path reaches
 * the `gh` binary (the set exported as MODES_REQUIRING_GH by the script
 * itself — not hardcoded here) must carry GH_TOKEN in its effective
 * (job ∪ step) env. The cleanup job's apply step shipped without it on
 * 2026-09-06 and failed on every release since, silently, because publish-npm
 * does not depend on the cleanup job.
 *
 * The violation collector is exercised against an in-memory mutated workflow
 * (GH_TOKEN stripped) to prove it discriminates, so no on-disk mutation is
 * needed for the red/green pair.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { MODES_REQUIRING_GH } from '../../../../scripts/release-notes-fragments.mjs';

const root = path.resolve(import.meta.dir, '../../../..');
const GUARDED_WORKFLOWS = [
	'.github/workflows/release-and-publish.yml',
	'.github/workflows/drift-check.yml',
] as const;

interface WorkflowStep {
	name?: string;
	run?: string;
	env?: Record<string, string>;
}

interface WorkflowJob {
	env?: Record<string, string>;
	steps?: WorkflowStep[];
}

type WorkflowDoc = { jobs?: Record<string, WorkflowJob> };

function modesInvokedByStep(
	run: string,
	modesRequiringGh: readonly string[],
): string[] {
	const invoked: string[] = [];
	for (const mode of modesRequiringGh) {
		const pattern = new RegExp(
			`release-notes-fragments\\.mjs\\s+${mode}(?![\\w-])`,
		);
		if (pattern.test(run)) invoked.push(mode);
	}
	return invoked.sort();
}

function findMissingGhTokenSteps(
	doc: WorkflowDoc,
	modesRequiringGh: readonly string[],
): Array<{ jobId: string; stepName: string; modes: string[] }> {
	const violations: Array<{
		jobId: string;
		stepName: string;
		modes: string[];
	}> = [];
	for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
		const jobEnv = job?.env && typeof job.env === 'object' ? job.env : {};
		for (const step of job?.steps ?? []) {
			const run = typeof step?.run === 'string' ? step.run : '';
			if (!run.includes('release-notes-fragments.mjs')) continue;
			const modes = modesInvokedByStep(run, modesRequiringGh);
			if (modes.length === 0) continue;
			const stepEnv = step?.env && typeof step.env === 'object' ? step.env : {};
			const effectiveEnv = { ...jobEnv, ...stepEnv };
			if (!('GH_TOKEN' in effectiveEnv)) {
				violations.push({
					jobId,
					stepName: step.name ?? '<unnamed>',
					modes,
				});
			}
		}
	}
	return violations;
}

function guardedStepCount(
	doc: WorkflowDoc,
	modesRequiringGh: readonly string[],
): number {
	let count = 0;
	for (const job of Object.values(doc.jobs ?? {})) {
		for (const step of job?.steps ?? []) {
			const run = typeof step?.run === 'string' ? step.run : '';
			if (modesInvokedByStep(run, modesRequiringGh).length > 0) count += 1;
		}
	}
	return count;
}

describe('release-fragments gh-auth workflow shape (issue 2898)', () => {
	test('MODES_REQUIRING_GH is exactly the four gh-dependent modes', () => {
		expect([...MODES_REQUIRING_GH].sort()).toEqual([
			'apply-cleanup',
			'prepare-cleanup',
			'update-pr',
			'update-release',
		]);
		expect(MODES_REQUIRING_GH).not.toContain('verify-retention');
		expect(MODES_REQUIRING_GH).not.toContain('prepare-historical-batch');
	});

	for (const workflowPath of GUARDED_WORKFLOWS) {
		test(`${workflowPath}: every gh-dependent fragment-script step carries GH_TOKEN`, () => {
			const text = readFileSync(path.join(root, workflowPath), 'utf8');
			const doc = parse(text) as WorkflowDoc;
			const violations = findMissingGhTokenSteps(doc, MODES_REQUIRING_GH);
			expect(violations).toEqual([]);
		});
	}

	test('the release workflow scan is non-vacuous (guarded steps exist)', () => {
		const text = readFileSync(
			path.join(root, '.github/workflows/release-and-publish.yml'),
			'utf8',
		);
		const doc = parse(text) as WorkflowDoc;
		// update-release, prepare-cleanup, apply-cleanup (dry-run + apply in one
		// step), and update-pr: four guarded steps today. Use >= so adding a
		// compliant step stays green while proving the scan actually matches.
		expect(guardedStepCount(doc, MODES_REQUIRING_GH)).toBeGreaterThanOrEqual(4);
	});

	test('drift-check only invokes the non-gh verify-retention mode (no over-trigger)', () => {
		const text = readFileSync(
			path.join(root, '.github/workflows/drift-check.yml'),
			'utf8',
		);
		const doc = parse(text) as WorkflowDoc;
		expect(guardedStepCount(doc, MODES_REQUIRING_GH)).toBe(0);
		expect(findMissingGhTokenSteps(doc, MODES_REQUIRING_GH)).toEqual([]);
	});

	test('mutation RED: stripping GH_TOKEN from the apply step is flagged', () => {
		const text = readFileSync(
			path.join(root, '.github/workflows/release-and-publish.yml'),
			'utf8',
		);
		const doc = parse(text) as WorkflowDoc;
		const applySteps = Object.entries(doc.jobs ?? {})
			.flatMap(([jobId, job]) =>
				(job?.steps ?? []).map((step) => ({ jobId, step })),
			)
			.filter(
				({ step }) => step.name === 'Validate and apply fragment cleanup',
			);
		expect(applySteps.length).toBe(1);
		const target = applySteps[0];
		expect(target.step.env && 'GH_TOKEN' in target.step.env).toBe(true);
		const mutated: WorkflowDoc = JSON.parse(JSON.stringify(doc));
		const mutatedStep = Object.values(mutated.jobs ?? {})
			.flatMap((job) => job?.steps ?? [])
			.find((step) => step.name === 'Validate and apply fragment cleanup');
		delete mutatedStep?.env?.GH_TOKEN;
		const violations = findMissingGhTokenSteps(mutated, MODES_REQUIRING_GH);
		expect(violations).toEqual([
			{
				jobId: target.jobId,
				stepName: 'Validate and apply fragment cleanup',
				modes: ['apply-cleanup'],
			},
		]);
	});

	test('mutation RED: a job-level env does not silently satisfy a stripped step env', () => {
		const doc: WorkflowDoc = {
			jobs: {
				example: {
					env: { GH_TOKEN: 'job-level' },
					steps: [
						{
							name: 'Runs a gh mode with step env override',
							run: 'node scripts/release-notes-fragments.mjs apply-cleanup --plan p.json',
							env: { TAG_NAME: 'v0.0.0' },
						},
					],
				},
			},
		};
		// Effective env = job ∪ step, so the job-level token DOES satisfy the
		// guard when present...
		expect(findMissingGhTokenSteps(doc, MODES_REQUIRING_GH)).toEqual([]);
		const withoutJobEnv: WorkflowDoc = JSON.parse(JSON.stringify(doc));
		delete withoutJobEnv.jobs?.example?.env;
		// ...and removing it flips the step to a violation.
		expect(findMissingGhTokenSteps(withoutJobEnv, MODES_REQUIRING_GH)).toEqual([
			{
				jobId: 'example',
				stepName: 'Runs a gh mode with step env override',
				modes: ['apply-cleanup'],
			},
		]);
	});
});
