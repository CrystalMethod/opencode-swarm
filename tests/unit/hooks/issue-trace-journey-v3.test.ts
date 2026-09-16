/**
 * Ingestion journey (issue #2564), part 1: issue input → spec → v3 receipts →
 * PLAN → durable plan through the real ledger → interruption/resume → EXECUTE.
 * Real machinery only (no _internals behavioral overrides). Under 500 lines
 * (FR-006).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	createJourneyProject,
	handleIssueCommand,
	loadPlan,
} from './issue-trace-journey-v3-helpers';

let project: ReturnType<typeof createJourneyProject> | null = null;
afterEach(() => {
	project?.cleanup();
	project = null;
});

describe('issue-ingestion journey v3 — ingestion through resume', () => {
	test('issue input emits the ISSUE_INGEST signal and persists durable state', () => {
		project = createJourneyProject();
		const signal = handleIssueCommand(project.dir, [
			'ZaxbyHub/opencode-swarm#2564',
			'--trace',
		]);
		expect(signal).toBe(
			'[MODE: ISSUE_INGEST issue="https://github.com/ZaxbyHub/opencode-swarm/issues/2564" plan=true trace=true]',
		);
		expect(
			fs.existsSync(path.join(project.dir, '.swarm', 'issue-reference.json')),
		).toBe(true);
		expect(
			fs.existsSync(path.join(project.dir, '.swarm', 'issue-trace-state.json')),
		).toBe(true);
	});

	test('spec missing: the engine waits (row e) with no state change', async () => {
		project = createJourneyProject();
		handleIssueCommand(project.dir, [
			'ZaxbyHub/opencode-swarm#2564',
			'--trace',
		]);
		const step = await project.cycle();
		expect(step.state.lastTransition).toBeNull();
		expect(step.state.status).toBe('in_progress');
	});

	test('freshness receipt then repro gate: each gate surfaces the actionable next step', async () => {
		project = createJourneyProject();
		handleIssueCommand(project.dir, [
			'ZaxbyHub/opencode-swarm#2564',
			'--trace',
		]);
		project.writeSpec();

		// Phase 0 v3 receipt via the REAL tool.
		const fresh = await project.recordFreshness();
		expect(fresh.success).toBe(true);

		// Without reproduction evidence the engine nudges exactly once.
		const step = await project.cycle();
		expect(step.state.lastTransition).toBe('REPRO_GATE');
		expect(step.text).toMatch(/reproduc/i);

		const repro = await project.recordRepro();
		expect(repro.success).toBe(true);

		const plan = await project.cycle();
		expect(plan.state.lastTransition).toBe('ISSUE_INGEST_TO_PLAN');
		expect(plan.state.status).toBe('in_progress');
	});

	test('durable plan through the real ledger carries acceptance, files, and requirement references', async () => {
		project = createJourneyProject();
		handleIssueCommand(project.dir, [
			'ZaxbyHub/opencode-swarm#2564',
			'--trace',
		]);
		project.writeSpec();
		await project.recordFreshness();
		await project.recordRepro();
		await project.cycle(); // ISSUE_INGEST_TO_PLAN

		await project.saveJourneyPlan('in_progress', 'in_progress');
		expect(
			fs.existsSync(path.join(project.dir, '.swarm', 'plan-ledger.jsonl')),
		).toBe(true);
		const loaded = await loadPlan(project.dir);
		const task = loaded?.phases?.[0]?.tasks?.[0];
		expect(typeof task?.acceptance).toBe('string');
		expect((task?.acceptance ?? '').length).toBeGreaterThan(0);
		expect(Array.isArray(task?.files_touched)).toBe(true);
		expect((task?.files_touched ?? []).length).toBeGreaterThan(0);
		expect(Array.isArray(task?.fr_refs)).toBe(true);
		expect((task?.fr_refs ?? []).length).toBeGreaterThan(0);
	});

	test('interruption/resume: cache resets do not restart the trace (row g waits silently)', async () => {
		project = createJourneyProject();
		handleIssueCommand(project.dir, [
			'ZaxbyHub/opencode-swarm#2564',
			'--trace',
		]);
		project.writeSpec();
		await project.recordFreshness();
		await project.recordRepro();
		await project.cycle();
		await project.saveJourneyPlan('in_progress', 'in_progress');

		// Simulated restart: in-memory caches drop, on-disk state is all that
		// remains. The trace resumes where it left off (critic gate pending,
		// row g silent) rather than re-running earlier gates.
		project.resetCaches();
		const step = await project.cycle();
		expect(step.state.lastTransition).toBe('ISSUE_INGEST_TO_PLAN');
		expect(step.state.status).toBe('in_progress');
		expect(step.text).toBe('');
	});

	test('critic approval via the real architect-session path drives EXECUTE', async () => {
		project = createJourneyProject();
		handleIssueCommand(project.dir, [
			'ZaxbyHub/opencode-swarm#2564',
			'--trace',
		]);
		project.writeSpec();
		await project.recordFreshness();
		await project.recordRepro();
		await project.cycle();
		await project.saveJourneyPlan('in_progress', 'in_progress');

		const approved = await project.approveCritic();
		expect(approved.success).toBe(true);

		const step = await project.cycle();
		expect(step.state.lastTransition).toBe('PLAN_TO_EXECUTE');
		expect(step.text).toMatch(/\[MODE: EXECUTE\]/);
	});
});
