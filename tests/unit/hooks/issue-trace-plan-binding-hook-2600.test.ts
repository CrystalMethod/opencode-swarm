/**
 * Regression suite for issue #2600 (hook / command / journey legs): the
 * binding + one-shot directives through the REAL hook (real files on disk;
 * only the approval input is seam-injected — the delegated-truth pattern),
 * the non-trace state hygiene in handleIssueCommand, and the foreign-plan
 * leg through the real journey machinery. The reducer legs live in
 * issue-trace-plan-binding-2600.test.ts. Under 500 lines (FR-006).
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleIssueCommand } from '../../../src/commands/issue';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { createJourneyProject } from './issue-trace-journey-v3-helpers';
import {
	hookInternals,
	readState,
	runHook,
	seedDir,
	sha,
} from './issue-trace-plan-binding-2600.helpers';

// ── Hook: foreign plan through the real engine (AC1, hook leg) ──────

describe('issue #2600 — hook-level one-shot directives (spec mismatch / timeout)', () => {
	test('cross-issue spec mismatch surfaces a ONE-SHOT directive, then waits quietly', async () => {
		const dir = await seedDir({ specNumber: 99, planSpecHash: null });
		const { messages } = await runHook(dir);
		expect(messages).toHaveLength(2);
		expect(readState(dir)?.lastTransition).toBe('SPEC_MISMATCH_GATE');

		// Second drive: already nudged once → silent noop.
		const second = await runHook(dir);
		expect(second.messages).toHaveLength(0);
	});

	test('trace-state issueNumber mismatch surfaces the same one-shot directive', async () => {
		const dir = await seedDir({ planSpecHash: null });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'issue-trace-state.json'),
			JSON.stringify(
				{ issueNumber: 99, lastTransition: null, status: 'in_progress' },
				null,
				2,
			),
			'utf-8',
		);
		const { messages } = await runHook(dir);
		expect(messages).toHaveLength(2);
		expect(readState(dir)?.lastTransition).toBe('SPEC_MISMATCH_GATE');
	});

	test('timeout: approval slower than the bound → fail-closed after timeout, CRITIC_GATE surfaces', async () => {
		// A bound plan with an incomplete phase (real plan.json on disk) and a
		// typed --no-repro waiver: row g (critic pending) is what applies. The
		// seam resolves TRUE only well past the hook's 100 ms bound, so the
		// outcome is genuinely timeout-dependent (review pr2837-r1 F4): if the
		// bounded-approval timeout ever regressed and the hook awaited the late
		// promise, criticApproved would flip to true, row (h) would advance the
		// trace to PLAN_TO_EXECUTE, and BOTH assertions below would fail. A
		// never-resolving seam cannot discriminate that way — the real loader
		// also returns false fast on this seed, so the old shape passed even
		// with the timeout removed.
		const dir = await seedDir({ planSpecHash: 'auto', noReproWaiver: true });
		hookInternals.isPlanCriticApproved = () =>
			new Promise<boolean>((resolve) => {
				setTimeout(() => resolve(true), 250);
			});

		const { messages } = await runHook(dir);
		expect(messages).toHaveLength(2);
		expect(readState(dir)?.lastTransition).toBe('CRITIC_GATE');
	});
});

describe('issue #2600 — plan binding gate (hook, real files)', () => {
	test('a critic-approved plan whose specHash belongs to another spec parks the trace (never EXECUTE)', async () => {
		// hash of a DIFFERENT spec — the pre-overwrite spec of another issue
		const dir = await seedDir({
			planSpecHash: sha('# Spec\n\n## Source Issue\n\n- Number: 41\n'),
		});
		hookInternals.isPlanCriticApproved = () => Promise.resolve(true);

		const { messages } = await runHook(dir);
		const text = JSON.stringify(messages);
		expect(text).not.toContain('[MODE: EXECUTE]');
		expect(text).toMatch(/bind|bound|mismatch|foreign|spec/i);
		expect(readState(dir)?.lastTransition).toBe('PLAN_BINDING_GATE');
	});

	test('a bound plan with approval and reproduction proceeds to EXECUTE', async () => {
		const dir = await seedDir({ planSpecHash: 'auto', noReproWaiver: true });
		hookInternals.isPlanCriticApproved = () => Promise.resolve(true);

		const { messages } = await runHook(dir);
		expect(JSON.stringify(messages)).toContain('[MODE: EXECUTE]');
		expect(readState(dir)?.lastTransition).toBe('PLAN_TO_EXECUTE');
	});

	test('a plan with no recorded specHash under an active trace fails closed', async () => {
		const dir = await seedDir({});
		hookInternals.isPlanCriticApproved = () => Promise.resolve(true);

		const { messages } = await runHook(dir);
		const text = JSON.stringify(messages);
		expect(text).not.toContain('[MODE: EXECUTE]');
		expect(readState(dir)?.lastTransition).toBe('PLAN_BINDING_GATE');
	});
});

// ── Command: non-trace state hygiene (AC3) ──────────────────────────

describe('issue #2600 — non-trace invocation leaves no in_progress trace state', () => {
	let dir: string;
	const mkDir = () => {
		dir = canonicalMkdtemp('issue-cmd-2600-');
		fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /nonexistent\n', 'utf-8');
	};

	test('no flags → issue-reference.json only, no trace-state file', () => {
		mkDir();
		const result = handleIssueCommand(dir, [
			'https://github.com/owner/repo/issues/42',
		]);
		expect(result).toContain('[MODE: ISSUE_INGEST');
		expect(
			fs.existsSync(path.join(dir, '.swarm', 'issue-reference.json')),
		).toBe(true);
		expect(
			fs.existsSync(path.join(dir, '.swarm', 'issue-trace-state.json')),
		).toBe(false);
	});

	test('pre-existing trace-state is left byte-identical by a non-trace invocation', () => {
		mkDir();
		const seeded = JSON.stringify(
			{
				issueNumber: 7,
				lastTransition: 'PLAN_TO_EXECUTE',
				status: 'in_progress',
			},
			null,
			2,
		);
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'issue-trace-state.json'),
			seeded,
			'utf-8',
		);
		handleIssueCommand(dir, ['https://github.com/owner/repo/issues/42']);
		expect(
			fs.readFileSync(
				path.join(dir, '.swarm', 'issue-trace-state.json'),
				'utf-8',
			),
		).toBe(seeded);
	});

	test('--trace still persists the in_progress trace state', () => {
		mkDir();
		handleIssueCommand(dir, [
			'https://github.com/owner/repo/issues/43',
			'--trace',
		]);
		const state = readState(dir);
		expect(state?.issueNumber).toBe(43);
		expect(state?.status).toBe('in_progress');
	});
});

// ── Journey: foreign plan through the real machinery (AC1, journey leg) ──

describe('issue #2600 — foreign plan through the real journey machinery', () => {
	let project: ReturnType<typeof createJourneyProject> | null = null;
	const cleanup = () => {
		project?.cleanup();
		project = null;
	};

	test('a plan saved against a different spec parks the real trace at PLAN_BINDING_GATE', async () => {
		try {
			project = createJourneyProject();
			handleIssueCommand(project.dir, [
				'ZaxbyHub/opencode-swarm#2564',
				'--trace',
			]);
			project.writeSpec();
			await project.recordFreshness();
			await project.recordRepro();
			await project.cycle(); // ISSUE_INGEST_TO_PLAN

			// Save the journey plan, then REWRITE the spec — the plan's recorded
			// specHash now belongs to the old spec, exactly the #2600 wedge.
			await project.saveJourneyPlan('in_progress', 'in_progress');
			const specPath = path.join(project.dir, '.swarm', 'spec.md');
			fs.writeFileSync(
				specPath,
				'# Spec\n\n## Source Issue\n\n- Number: 2564\n\n## Details\n\nCHANGED requirements.\n',
				'utf-8',
			);
			project.resetCaches();

			const step = await project.cycle();
			expect(step.state.lastTransition).toBe('PLAN_BINDING_GATE');
			expect(step.text).toMatch(/bind|bound|mismatch|foreign|spec/i);
		} finally {
			cleanup();
		}
	});
});
