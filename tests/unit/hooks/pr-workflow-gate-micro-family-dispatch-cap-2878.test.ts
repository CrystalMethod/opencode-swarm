import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
	recordPrReviewMicroFamilyDispatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	PR_REVIEW_BASE_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

// Issue #2878 acceptance check C4 (NEW-SURFACE — RED at base): the
// micro-family dispatch attempt ledger is bounded at the workflow batch cap
// with a POSITIVE cap behavior (a BLOCKED refusal — never silent loss), and
// the crash-window disposition of the ledger is documented in the recording
// site's code comment and the canonical skill reference doc.

const FAMILY = 'unclassified-risk';

beforeEach(async () => {
	setupPrWorkflowGateFixtures();
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
	await bindPrReviewBase(tempDir, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: PR_REVIEW_BASE_SHA,
	});
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	await teardownPrWorkflowGateFixtures();
});

describe('PR-review micro-family dispatch ledger lifecycle (issue #2878)', () => {
	test('micro-family dispatch records stay bounded at the workflow batch cap', async () => {
		let capRefusal: string | null = null;
		// MAX_WORKFLOW_BATCHES is 128; one beyond the cap must be refused
		// (fail-closed, no silent eviction) rather than silently dropped.
		for (let index = 1; index <= 129; index++) {
			const batchId = `cap-attempt-${index}`;
			try {
				await recordPrReviewMicroFamilyDispatch(
					tempDir,
					SESSION_ID,
					[{ laneId: `${batchId}-lane`, workflowLane: FAMILY }],
					{ batchId, prHeadSha: HEAD_SHA },
				);
			} catch (error) {
				capRefusal = error instanceof Error ? error.message : String(error);
				break;
			}
		}
		expect(capRefusal).not.toBeNull();
		expect(capRefusal).toMatch(
			/BLOCKED: PR_REVIEW micro-family dispatch ledger limit reached/,
		);

		gateInternals.resetTrackedStateCache();
		const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(state).not.toBeNull();
		const records = state?.prReviewMicroFamilyDispatches ?? [];
		expect(records.length).toBeGreaterThan(0);
		expect(records.length).toBeLessThanOrEqual(128);
		const batchIds = new Set(records.map((record) => record.batchId));
		expect(batchIds.size).toBe(records.length);
	});

	test('crash-window disposition is stated in code comment and reference doc', () => {
		const gateSource = readFileSync(
			join(
				import.meta.dir,
				'..',
				'..',
				'..',
				'src',
				'hooks',
				'pr-workflow-gate.ts',
			),
			'utf-8',
		);
		expect(gateSource).toMatch(/crash[- ]window/i);

		const referenceDoc = readFileSync(
			join(
				import.meta.dir,
				'..',
				'..',
				'..',
				'.opencode',
				'skills',
				'swarm-pr-review',
				'references',
				'lane-output-recoverability.md',
			),
			'utf-8',
		);
		expect(referenceDoc).toMatch(/crash[- ]window/i);
	});
});
