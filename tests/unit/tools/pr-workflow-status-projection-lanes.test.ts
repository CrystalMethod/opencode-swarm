/**
 * pr_workflow_status — PR_REVIEW projection: lane coverage + read-time-only
 * derivation (issue #3095 AC2/AC4). Boundaries/inventory coverage lives in the
 * sibling `pr-workflow-status-projection-boundaries.test.ts` suite; shared
 * fixtures live in `pr-workflow-status-projection.fixtures.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readDelegationsDetailed } from '../../../src/background/pending-delegations';
import { SESSION_ID, tempDir } from '../hooks/pr-workflow-gate.test-fixtures';
import {
	INVENTORY_CAP,
	installProjectionGateState,
	installProjectionTestEnv,
	LANE_ROWS_CAP,
	PROJECTION_WFI,
	placeReceiptLane,
	restoreProjectionTestEnv,
	runProjectionTool,
	snapshotTreeHashes,
} from './pr-workflow-status-projection.fixtures';

beforeEach(() => {
	installProjectionTestEnv();
});

afterEach(async () => {
	await restoreProjectionTestEnv();
});

describe('pr_workflow_status — prReviewProjection.laneCoverage (AC2)', () => {
	test('per-lane rows with receipt counts, rejection counts, one-line markers', async () => {
		installProjectionGateState({
			workflowInstanceId: PROJECTION_WFI,
			prReviewBaseDispatches: [
				{
					batchId: 'base-1',
					lanes: [
						{ laneId: 'lane-sec', workflowLane: 'security-trust' },
						{ laneId: 'lane-corr', workflowLane: 'correctness-state' },
						{ laneId: 'lane-x', workflowLane: 'intent-architecture' },
					],
					validatedAt: '2026-01-01T00:00:00.000Z',
				},
			],
			prReviewSubmitRejections: [
				{
					childSessionId: 'child-sec',
					laneId: 'lane-sec',
					at: 1,
					message: 'rejected submit attempt',
				},
				{
					childSessionId: 'child-other',
					laneId: 'lane-not-declared',
					at: 2,
					message: 'unrelated',
				},
			],
		});
		await placeReceiptLane({
			batchId: 'base-1',
			laneId: 'lane-sec',
			workflowLane: 'security-trust',
			outcome: 'FINDINGS',
			findings: [
				{ id: 'F-001', severity: 'LOW', title: 'first finding title' },
				{ id: 'F-002', severity: 'HIGH', title: 'second finding title' },
			],
			childSessionId: 'child-sec',
		});
		await placeReceiptLane({
			batchId: 'base-1',
			laneId: 'lane-corr',
			workflowLane: 'correctness-state',
			outcome: 'CLEAN',
			childSessionId: 'child-corr',
		});

		const parsed = await runProjectionTool(tempDir, SESSION_ID);
		const projection = (parsed.gate as Record<string, unknown>)
			.prReviewProjection as Record<string, unknown>;
		expect(projection.laneCoverageTruncated).toBe(false);
		expect(projection.laneCoverage).toEqual([
			{
				laneId: 'lane-sec',
				workflowLane: 'security-trust',
				batchId: 'base-1',
				accepted: 2,
				rejected: 1,
				latestFinding: 'HIGH F-002: second finding title',
			},
			{
				laneId: 'lane-corr',
				workflowLane: 'correctness-state',
				batchId: 'base-1',
				accepted: 0,
				rejected: 0,
				latestFinding: 'clean',
			},
			{
				laneId: 'lane-x',
				workflowLane: 'intent-architecture',
				batchId: 'base-1',
				accepted: 0,
				rejected: 0,
				latestFinding: 'no-receipt',
			},
		]);
		// Receipt body prose never reaches the projection (AC4 one-line rule).
		expect(JSON.stringify(parsed)).not.toContain(
			'receipt body prose stays out of the projection',
		);
		// Sanity: the inventory projection is present alongside the rows.
		expect((projection.inventory as Record<string, unknown>).cap).toBe(
			INVENTORY_CAP,
		);
	});

	test('declared lanes beyond the cap truncate with a flag', async () => {
		const DIMENSIONS = [
			'intent-architecture',
			'correctness-state',
			'tests-falsifiability',
			'security-trust',
			'reliability-performance',
			'compatibility-delivery',
		];
		installProjectionGateState({
			workflowInstanceId: PROJECTION_WFI,
			prReviewBaseDispatches: [
				{
					batchId: 'base-wide',
					lanes: Array.from({ length: LANE_ROWS_CAP + 3 }, (_v, i) => ({
						laneId: `lane-${i}`,
						workflowLane: DIMENSIONS[i % DIMENSIONS.length],
					})),
					validatedAt: '2026-01-01T00:00:00.000Z',
				},
			],
		});
		const parsed = await runProjectionTool(tempDir, SESSION_ID);
		const projection = (parsed.gate as Record<string, unknown>)
			.prReviewProjection as Record<string, unknown>;
		const rows = projection.laneCoverage as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(LANE_ROWS_CAP);
		expect(projection.laneCoverageTruncated).toBe(true);
		expect(rows[0]).toMatchObject({ laneId: 'lane-0', batchId: 'base-wide' });
	});
});

describe('pr_workflow_status — projection writes nothing (AC4)', () => {
	test('the tool run leaves the settled .swarm tree byte-identical', async () => {
		installProjectionGateState({
			workflowInstanceId: PROJECTION_WFI,
			prReviewBaseDispatches: [
				{
					batchId: 'base-nw',
					lanes: [{ laneId: 'lane-nw', workflowLane: 'security-trust' }],
					validatedAt: '2026-01-01T00:00:00.000Z',
				},
			],
		});
		await placeReceiptLane({
			batchId: 'base-nw',
			laneId: 'lane-nw',
			workflowLane: 'security-trust',
			outcome: 'FINDINGS',
			findings: [
				{ id: 'F-772', severity: 'HIGH', title: 'receipt-only title' },
			],
			childSessionId: 'child-nw',
		});
		// The delegation store performs a documented one-time legacy-import
		// reconciliation on its FIRST read; settle it before the baseline so
		// byte-identity pins the TOOL run, not the store's migration.
		const priming = readDelegationsDetailed(tempDir);
		expect(priming.status).toBe('ok');
		const before = await snapshotTreeHashes(`${tempDir}/.swarm`);
		expect(Object.keys(before).length).toBeGreaterThan(0);

		const parsed = await runProjectionTool(tempDir, SESSION_ID);
		expect(
			(
				(parsed.gate as Record<string, unknown>).prReviewProjection as Record<
					string,
					unknown
				>
			).laneCoverage,
		).toEqual([
			{
				laneId: 'lane-nw',
				workflowLane: 'security-trust',
				batchId: 'base-nw',
				accepted: 1,
				rejected: 0,
				latestFinding: 'HIGH F-772: receipt-only title',
			},
		]);

		const after = await snapshotTreeHashes(`${tempDir}/.swarm`);
		expect(after).toEqual(before);
	});
});
