/**
 * pr_workflow_status — PR_REVIEW projection: boundaries + inventory
 * (issue #3095 AC1/AC3). Lane-coverage coverage lives in the sibling
 * `pr-workflow-status-projection-lanes.test.ts` suite; shared fixtures live in
 * `pr-workflow-status-projection.fixtures.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures';
import {
	BASE_CANDIDATE_HEADER,
	INVENTORY_CAP,
	installProjectionGateState,
	installProjectionTestEnv,
	PROJECTION_WFI,
	restoreProjectionTestEnv,
	runProjectionTool,
} from './pr-workflow-status-projection.fixtures';

beforeEach(() => {
	installProjectionTestEnv();
});

afterEach(async () => {
	await restoreProjectionTestEnv();
});

describe('pr_workflow_status — prReviewProjection.boundaries (AC1)', () => {
	test('settled/pending per boundary with checkpoint reference and settled-only digests', async () => {
		installProjectionGateState({
			workflowInstanceId: PROJECTION_WFI,
			prReviewArtifactBoundaries: ['post_explorer', 'post_critic'],
			prReviewArtifactRunId: 'run-9a3f',
			prReviewFindingsPath: 'pr-review/run-9a3f/findings.json',
			prReviewVerdictSettlementDigests: {
				reviewer: 'd'.repeat(64),
				critic: 'c'.repeat(64),
			},
		});
		const parsed = await runProjectionTool(tempDir, SESSION_ID);
		const gate = parsed.gate as Record<string, unknown>;
		expect(gate.active).toBe(true);
		const projection = gate.prReviewProjection as Record<string, unknown>;
		expect(projection).toBeDefined();
		// Honest checkpoint labelling (ported from #3188): the runId/findingsPath
		// each row carries is a SHARED last-write-wins reference, never
		// per-boundary evidence.
		expect(projection.checkpointScope).toBe('shared-last-write-wins');
		expect(projection.sources).toEqual({
			boundaries: { state: 'ok' },
			laneCoverage: { state: 'ok' },
		});
		expect(projection.laneCoverageAdmission).toBe('lane-record-only');
		expect(projection.boundaries).toEqual([
			{
				phase: 'post_explorer',
				status: 'settled',
				runId: 'run-9a3f',
				findingsPath: 'pr-review/run-9a3f/findings.json',
				settlementDigest: null,
			},
			{
				phase: 'post_reviewer',
				status: 'pending',
				runId: 'run-9a3f',
				findingsPath: 'pr-review/run-9a3f/findings.json',
				settlementDigest: null,
			},
			{
				phase: 'post_critic',
				status: 'settled',
				runId: 'run-9a3f',
				findingsPath: 'pr-review/run-9a3f/findings.json',
				settlementDigest: 'c'.repeat(64),
			},
		]);
	});

	test('PR_FEEDBACK gates carry no projection at all', async () => {
		installProjectionGateState({
			mode: 'PR_FEEDBACK',
			prFeedbackTargetUrl: 'https://github.com/o/r/pull/1',
			prReviewArtifactRunId: 'run-leak',
		});
		const feedback = await runProjectionTool(tempDir, SESSION_ID);
		const feedbackGate = feedback.gate as Record<string, unknown>;
		expect(feedbackGate.active).toBe(true);
		expect(feedbackGate.prReviewProjection).toBeUndefined();
		expect(JSON.stringify(feedback)).not.toContain('prReviewProjection');
		expect(JSON.stringify(feedback)).not.toContain('run-leak');
	});

	test('inactive gates carry no projection key', async () => {
		// No gate-state stub installed: the real reader sees an empty temp dir.
		const inactive = await runProjectionTool(tempDir, SESSION_ID);
		const gate = inactive.gate as Record<string, unknown>;
		expect(gate.active).toBe(false);
		expect(gate.prReviewProjection).toBeUndefined();
	});
});

describe('pr_workflow_status — prReviewProjection.inventory (AC3)', () => {
	test('clean sentinel when no discovery sources admit', async () => {
		installProjectionGateState({ workflowInstanceId: PROJECTION_WFI });
		const parsed = await runProjectionTool(tempDir, SESSION_ID);
		const projection = (parsed.gate as Record<string, unknown>)
			.prReviewProjection as Record<string, unknown>;
		expect(projection.inventory).toEqual({
			state: 'available',
			ids: ['CLEAN-REVIEW'],
			truncated: false,
			total: 1,
			cap: INVENTORY_CAP,
		});
	});

	test('derivation longer than the cap truncates with total retained', async () => {
		const lane = { laneId: 'security-trust', workflowLane: 'security-trust' };
		installProjectionGateState({
			workflowInstanceId: PROJECTION_WFI,
			prReviewBaseDispatches: [
				{
					batchId: 'base-inv',
					lanes: [lane],
					validatedAt: '2026-01-01T00:00:00.000Z',
				},
			],
		});
		const candidateCount = INVENTORY_CAP + 3;
		const rows = Array.from(
			{ length: candidateCount },
			(_v, i) =>
				`C-${String(i).padStart(3, '0')} | security-trust | HIGH | correctness | file.ts:1 | claim-${i} | evidence-${i} | impact | HIGH | ORDINARY | `,
		);
		await persistBatch('base-inv', 'swarm-pr-review:base', [lane], {
			textOverride: [BASE_CANDIDATE_HEADER, ...rows].join('\n'),
		});

		const parsed = await runProjectionTool(tempDir, SESSION_ID);
		const inventory = (
			(parsed.gate as Record<string, unknown>).prReviewProjection as Record<
				string,
				unknown
			>
		).inventory as Record<string, unknown>;
		const ids = inventory.ids as string[];
		expect(ids).toHaveLength(INVENTORY_CAP);
		expect(ids[0]).toBe('C-000');
		expect(ids[ids.length - 1]).toBe('C-039');
		expect(inventory.truncated).toBe(true);
		expect(inventory.total).toBe(candidateCount);
		expect(inventory.cap).toBe(INVENTORY_CAP);
		expect(JSON.stringify(parsed)).not.toContain('C-042');
	});

	test('unbound head degrades the inventory with a typed unavailable reason', async () => {
		installProjectionGateState({ prHeadSha: undefined });
		const parsed = await runProjectionTool(tempDir, SESSION_ID);
		const gate = parsed.gate as Record<string, unknown>;
		expect(gate.active).toBe(true);
		const projection = gate.prReviewProjection as Record<string, unknown>;
		// Degraded, never fabricated: the unavailable arm carries a bounded
		// reason instead of a bare null, and the other sections still project.
		expect(projection.inventory).toEqual({
			state: 'unavailable',
			reason: 'active PR_REVIEW workflow is not bound to a PR head',
		});
		expect(projection.boundaries).toHaveLength(3);
		expect(projection.laneCoverage).toEqual([]);
	});
});
