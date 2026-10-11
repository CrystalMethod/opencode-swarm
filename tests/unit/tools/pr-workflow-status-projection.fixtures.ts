/**
 * Shared fixtures for the pr_workflow_status PR_REVIEW projection suites
 * (issue #3095). Bun scopes beforeEach/afterEach to whichever test file's
 * module evaluation was executing when the call happened, so each consuming
 * test file must call `installProjectionTestEnv()` / `restoreProjectionTestEnv()`
 * from its OWN beforeEach/afterEach — importing this module alone installs
 * nothing.
 */

import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	appendDelegationTransition,
	publishPrReviewResultReceipt,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import {
	encodePrReviewWorkflowBinding,
	type PrReviewResultReceipt,
	PrReviewResultReceiptSchema,
	prReviewLaneResultEnvelopeDigest,
} from '../../../src/background/pr-review-contract';
import type { ToolResult } from '../../../src/tools/create-tool';
import {
	_internals,
	pr_workflow_status,
} from '../../../src/tools/pr-workflow-status';
import {
	HEAD_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures';

export const LANE_ROWS_CAP = 30;
export const INVENTORY_CAP = 40;
export const BASE_CANDIDATE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';
export const PROJECTION_WFI = 'wfi-projection-test';
export const PROJECTION_BASE_SHA = '0123456789abcdef';

const realReadGate = _internals.readPrWorkflowGateStateForRecovery;
const realHead = _internals.resolveCurrentGitHeadAsync;
const realClean = _internals.resolveIsWorkingTreeCleanAsync;
const realRunGit = _internals.runGitCapture;
const realClassify = _internals.classifyGitState;

/** Per-file beforeEach: shared gate fixtures + deterministic git stubs. */
export function installProjectionTestEnv(): void {
	setupPrWorkflowGateFixtures();
	_internals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	_internals.resolveIsWorkingTreeCleanAsync = async () => true;
	_internals.classifyGitState = async () => ({
		kind: 'clean',
		code: 'CLEAN',
		retryable: true,
		requiredAction: 'No checkout recovery is required.',
		evidence: {
			worktreeRoot: tempDir,
			gitDir: `${tempDir}/.git`,
			operations: [],
			unmergedCodes: [],
			paths: [],
			trackedCount: 0,
			untrackedCount: 0,
			pathsTruncated: false,
		},
	});
	_internals.runGitCapture = async (_dir: string, args: string[]) => {
		if (args[0] === 'rev-parse') return 'HEAD\n';
		if (args[0] === 'status') return '';
		if (args[0] === 'remote') return '';
		return null;
	};
}

/** Per-file afterEach: restore seams, then tear down the temp dir. */
export async function restoreProjectionTestEnv(): Promise<void> {
	_internals.readPrWorkflowGateStateForRecovery = realReadGate;
	_internals.resolveCurrentGitHeadAsync = realHead;
	_internals.resolveIsWorkingTreeCleanAsync = realClean;
	_internals.runGitCapture = realRunGit;
	_internals.classifyGitState = realClassify;
	await teardownPrWorkflowGateFixtures();
}

export async function runProjectionTool(
	directory: string,
	sessionID?: string,
): Promise<Record<string, unknown>> {
	const result = await (
		pr_workflow_status as unknown as {
			execute: (args: unknown, ctx: ToolContext) => Promise<unknown>;
		}
	).execute({}, { directory, sessionID } as unknown as ToolContext);
	const text =
		typeof result === 'string' ? result : (result as ToolResult).output;
	return JSON.parse(text) as Record<string, unknown>;
}

export function installProjectionGateState(
	extras: Record<string, unknown>,
): void {
	_internals.readPrWorkflowGateStateForRecovery = async () => ({
		salvaged: false,
		schemaErrors: [],
		revisionSalvageable: true,
		armedShapeUnreadable: false,
		state: {
			schemaVersion: 1,
			revision: 1,
			sessionID: SESSION_ID,
			mode: 'PR_REVIEW',
			activatedAt: '2026-08-01T00:00:00.000Z',
			updatedAt: '2026-08-01T00:00:01.000Z',
			prHeadSha: HEAD_SHA,
			...extras,
		} as never,
	});
}

export async function placeReceiptLane(input: {
	batchId: string;
	laneId: string;
	workflowLane: string;
	outcome: 'FINDINGS' | 'CLEAN';
	findings?: Array<{ id: string; severity: string; title: string }>;
	childSessionId: string;
}): Promise<void> {
	await recordPendingDelegation(tempDir, {
		correlationId: input.childSessionId,
		jobId: encodePrReviewWorkflowBinding(PROJECTION_WFI),
		subagentSessionId: input.childSessionId,
		parentSessionId: SESSION_ID,
		callID: `call-${input.childSessionId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: input.batchId,
		laneId: input.laneId,
		mode: 'swarm-pr-review:base',
		workflowLane: input.workflowLane,
		workflowGeneration: 3,
		generation: 1,
		workspace: {
			directory: tempDir,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
	const envelope = {
		schemaVersion: 1,
		outcome: input.outcome,
		creditedLanes: [input.workflowLane],
		findings:
			input.outcome === 'FINDINGS'
				? (input.findings ?? []).map((finding) => ({
						id: finding.id,
						workflowLane: input.workflowLane,
						severity: finding.severity,
						riskImpact: 'ORDINARY',
						riskTags: [],
						title: finding.title,
						body: 'receipt body prose stays out of the projection',
						evidence: 'receipt evidence',
						location: {
							kind: 'non_local',
							label: 'receipt',
							detail: 'receipt location detail',
						},
					}))
				: [],
		cleanAttestations:
			input.outcome === 'CLEAN'
				? [
						{
							workflowLane: input.workflowLane,
							coverageScope: `complete PR diff scope for ${input.workflowLane}`,
							evidence: `no finding after focused invariant review of ${input.workflowLane}`,
						},
					]
				: [],
		unresolved: [],
	};
	const receipt = {
		schemaVersion: 1,
		mode: 'swarm-pr-review:base',
		workflowInstanceId: PROJECTION_WFI,
		workflowRevision: 3,
		batchId: input.batchId,
		laneId: input.laneId,
		workflowLane: input.workflowLane,
		ownedWorkflowLanes: [input.workflowLane],
		baseSha: PROJECTION_BASE_SHA,
		headSha: HEAD_SHA,
		dispatchRevisionDigest: 'a'.repeat(64),
		childSessionId: input.childSessionId,
		generation: 1,
		semanticEnvelopeDigest: prReviewLaneResultEnvelopeDigest(envelope),
		envelope,
	};
	const parsed = PrReviewResultReceiptSchema.safeParse(receipt);
	if (!parsed.success) {
		throw new Error(
			`fixture receipt invalid: ${JSON.stringify(parsed.error.issues)}`,
		);
	}
	const published = await publishPrReviewResultReceipt(tempDir, {
		parentSessionId: SESSION_ID,
		childSessionId: input.childSessionId,
		batchId: input.batchId,
		laneId: input.laneId,
		receipt: parsed.data as PrReviewResultReceipt,
		expectedWorkflowInstanceId: PROJECTION_WFI,
		expectedWorkflowRevision: 3,
		expectedBaseSha: PROJECTION_BASE_SHA,
	});
	if (published.status !== 'recorded') {
		throw new Error(`receipt publication failed: ${JSON.stringify(published)}`);
	}
	await appendDelegationTransition(tempDir, input.childSessionId, {
		status: 'completed',
		result: {
			chars: 4096,
			truncated: false,
			digest: 'f'.repeat(64),
			outputRef: `lane-outputs/${input.childSessionId}`,
			prReviewResultReceipt: parsed.data as PrReviewResultReceipt,
		},
	});
}

/** Recursive path → sha256 snapshot of a tree (used by the no-write pin). */
export async function snapshotTreeHashes(
	root: string,
): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	async function walk(dir: string): Promise<void> {
		let entries;
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = nodePath.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else {
				const rel = nodePath.relative(root, full).split(nodePath.sep).join('/');
				const buf = await fsp.readFile(full);
				out[rel] = crypto.createHash('sha256').update(buf).digest('hex');
			}
		}
	}
	await walk(root);
	return out;
}
