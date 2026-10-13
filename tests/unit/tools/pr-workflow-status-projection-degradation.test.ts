/**
 * pr_workflow_status — PR_REVIEW projection DEGRADATION branches (issue #3095,
 * review findings F-01 and F-04). These tests exist to FAIL if the
 * degradation logic regresses:
 *
 *  - F-01: a delegation-store receipt lookup that is UNCERTAIN — or throws
 *    outright — must degrade the lane row to `receipt-uncertain`, never to
 *    `no-receipt`. An unreadable store is UNKNOWN, not absent.
 *  - F-04: a gate state SALVAGED by the recovery reader drops every
 *    `prReview*` field; the projection must mark its derived sections
 *    `unavailable` with a bounded reason instead of reporting
 *    healthy-but-empty coverage (or fabricating the CLEAN-REVIEW sentinel).
 *  - F-08/B2: a derivation failure reason that carries repository-controlled
 *    markup must surface sanitized through the `unavailable` arm.
 *
 * Healthy-path coverage lives in the sibling `-boundaries` / `-lanes` suites;
 * shared fixtures in `pr-workflow-status-projection.fixtures.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
	BackgroundDelegationRecord,
	DelegationLookupOutcome,
} from '../../../src/background/pending-delegations';
import { _test_exports as gateTestExports } from '../../../src/hooks/pr-workflow-gate';
import { _internals } from '../../../src/tools/pr-workflow-status';
import {
	HEAD_SHA,
	SESSION_ID,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures';
import {
	installProjectionGateState,
	installProjectionTestEnv,
	PROJECTION_WFI,
	placeReceiptLane,
	restoreProjectionTestEnv,
	runProjectionTool,
} from './pr-workflow-status-projection.fixtures';

beforeEach(() => {
	installProjectionTestEnv();
});

afterEach(async () => {
	await restoreProjectionTestEnv();
});

type LaneRow = {
	laneId: string;
	latestFinding: string;
	accepted: number;
	findings: Array<{ id: string }>;
};

function projectionOf(
	parsed: Record<string, unknown>,
): Record<string, unknown> {
	return (parsed.gate as Record<string, unknown>).prReviewProjection as Record<
		string,
		unknown
	>;
}

function declaredTwoLaneState(): void {
	installProjectionGateState({
		workflowInstanceId: PROJECTION_WFI,
		prReviewBaseDispatches: [
			{
				batchId: 'base-deg',
				lanes: [
					{ laneId: 'lane-deg-a', workflowLane: 'security-trust' },
					{ laneId: 'lane-deg-b', workflowLane: 'correctness-state' },
				],
				validatedAt: '2026-01-01T00:00:00.000Z',
			},
		],
	});
}

describe('pr_workflow_status — receipt-lookup degradation (F-01)', () => {
	test('an UNCERTAIN store read marks rows receipt-uncertain, never no-receipt', async () => {
		declaredTwoLaneState();
		// Real receipt evidence exists for lane-deg-a; the store read being
		// uncertain must still WIN over the evidence — reading it through a
		// broken path would fabricate certainty.
		await placeReceiptLane({
			batchId: 'base-deg',
			laneId: 'lane-deg-a',
			workflowLane: 'security-trust',
			outcome: 'FINDINGS',
			findings: [
				{ id: 'F-900', severity: 'HIGH', title: 'behind an uncertain store' },
			],
			childSessionId: 'child-deg-a',
		});
		const uncertainOutcome: DelegationLookupOutcome<
			BackgroundDelegationRecord[]
		> = {
			status: 'uncertain',
			reason: 'store unreadable after retry',
			source: 'fold',
			attempts: 2,
		};
		_internals.findByBatchIdDetailed = () => uncertainOutcome;

		const parsed = await runProjectionTool(tempDir, SESSION_ID);
		const rows = projectionOf(parsed).laneCoverage as LaneRow[];
		expect(rows.map((row) => row.latestFinding)).toEqual([
			'receipt-uncertain',
			'receipt-uncertain',
		]);
		// Never an absence claim, and no finding content leaks through the
		// degraded read either.
		expect(JSON.stringify(rows)).not.toContain('no-receipt');
		expect(JSON.stringify(rows)).not.toContain('F-900');
		expect(rows.every((row) => row.findings.length === 0)).toBe(true);
	});

	test('a THROWING batch reader degrades to receipt-uncertain, never no-receipt', async () => {
		declaredTwoLaneState();
		_internals.findByBatchIdDetailed = (() => {
			throw new Error('reader threw unexpectedly');
		}) as typeof _internals.findByBatchIdDetailed;

		const parsed = await runProjectionTool(tempDir, SESSION_ID);
		const rows = projectionOf(parsed).laneCoverage as LaneRow[];
		expect(rows.map((row) => row.latestFinding)).toEqual([
			'receipt-uncertain',
			'receipt-uncertain',
		]);
		expect(JSON.stringify(rows)).not.toContain('no-receipt');
	});
});

describe('pr_workflow_status — salvaged gate state (F-04)', () => {
	test('a salvage that dropped prReview* fields marks the derived sections unavailable', async () => {
		// The minimal-salvage shape: identity fields survive, every prReview*
		// field is gone, and the recovery read flags the drop.
		_internals.readPrWorkflowGateStateForRecovery = (async () => ({
			salvaged: true,
			schemaErrors: ['prReviewBaseDispatches: invalid'],
			disclosure: 'salvage disclosure',
			revisionSalvageable: true,
			armedShapeUnreadable: false,
			prReviewProjectionDropped: true,
			state: {
				schemaVersion: 1,
				revision: 1,
				sessionID: SESSION_ID,
				mode: 'PR_REVIEW',
				activatedAt: '2026-08-01T00:00:00.000Z',
				updatedAt: '2026-08-01T00:00:01.000Z',
				prHeadSha: HEAD_SHA,
			} as never,
		})) as typeof _internals.readPrWorkflowGateStateForRecovery;

		const parsed = await runProjectionTool(tempDir, SESSION_ID);
		expect(parsed.success).toBe(true);
		const gate = parsed.gate as Record<string, unknown>;
		expect(gate.stateSalvaged).toBe(true);
		const projection = projectionOf(parsed);
		// Typed unavailable sources with bounded reasons — never healthy-empty.
		const sources = projection.sources as Record<
			string,
			{ state: string; reason?: string }
		>;
		expect(sources.boundaries.state).toBe('unavailable');
		expect(sources.boundaries.reason).toContain('salvaged');
		expect(sources.laneCoverage.state).toBe('unavailable');
		expect(sources.laneCoverage.reason).toContain('salvaged');
		// Shape stability: rows still project, degraded to all-pending/empty.
		const boundaries = projection.boundaries as Array<{
			status: string;
		}>;
		expect(boundaries).toHaveLength(3);
		expect(boundaries.every((row) => row.status === 'pending')).toBe(true);
		expect(projection.laneCoverage).toEqual([]);
		// The inventory must not fabricate the CLEAN-REVIEW sentinel from a
		// state whose discovery sources were dropped.
		const inventory = projection.inventory as Record<string, unknown>;
		expect(inventory.state).toBe('unavailable');
		expect(String(inventory.reason)).toContain('salvaged');
	});

	test('a healthy read keeps the sources ok (regression guard for the guard)', async () => {
		declaredTwoLaneState();
		const parsed = await runProjectionTool(tempDir, SESSION_ID);
		const projection = projectionOf(parsed);
		expect(projection.sources).toEqual({
			boundaries: { state: 'ok' },
			laneCoverage: { state: 'ok' },
		});
		expect((projection.inventory as Record<string, unknown>).state).toBe(
			'available',
		);
	});
});

describe('pr_workflow_status — unavailable-reason sanitization (F-08/B2)', () => {
	test('a hostile derivation error surfaces as a sanitized bounded reason', async () => {
		installProjectionGateState({ workflowInstanceId: PROJECTION_WFI });
		// Capture the real seam INSIDE the test body: Bun 1.3.14 executes
		// describe bodies in a collection phase where this `_test_exports`
		// member is observed as undefined (module-scope and test-time reads
		// both see the real function), so a describe-body capture would
		// "restore" undefined and poison every later co-run file.
		const realDetailedDigest =
			gateTestExports.resolvePrWorkflowRevisionDigestDetailed;
		try {
			gateTestExports.resolvePrWorkflowRevisionDigestDetailed = () => {
				throw new Error(
					'`<img src=x onerror=steal()>` \u0001HEAD\u0002 ' + 'A'.repeat(2000),
				);
			};

			const parsed = await runProjectionTool(tempDir, SESSION_ID);
			const projection = projectionOf(parsed);
			const inventory = projection.inventory as {
				state: string;
				reason: string;
			};
			expect(inventory.state).toBe('unavailable');
			// Same character classes every house sanitizer strips: no backticks,
			// no angle brackets, no control characters, bounded length. The words
			// inside the markup survive — the markup itself must not.
			expect(inventory.reason).not.toContain('`');
			expect(inventory.reason).not.toContain('<');
			expect(inventory.reason).not.toContain('>');
			expect(/[\p{Cc}]/u.test(inventory.reason)).toBe(false);
			// Control characters became spaces and collapsed; the 2000-char tail
			// was dropped. The gate caps at 240 chars (+1 ellipsis), the
			// tool-side boundUntrusted re-bound keeps it within one ellipsis.
			expect(inventory.reason.length).toBeLessThanOrEqual(241);
			expect(inventory.reason.startsWith('img src=x onerror=steal()')).toBe(
				true,
			);
		} finally {
			gateTestExports.resolvePrWorkflowRevisionDigestDetailed =
				realDetailedDigest;
		}
	});
});
