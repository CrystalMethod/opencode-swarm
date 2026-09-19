import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { CANDIDATE_HEADERS } from '../../../src/background/candidate-contract.js';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	claimTerminalResult,
	findByBatchId,
	findByCorrelationId,
} from '../../../src/background/pending-delegations.js';
import { PR_REVIEW_BASE_DIMENSION_IDS } from '../../../src/background/pr-review-contract.js';
import {
	PR_REVIEW_REQUIRED_TRIGGER_IDS,
	type PrReviewInlineTriggerRow,
} from '../../../src/background/pr-review-trigger-contract.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import { _internals as dispatchInternals } from '../../../src/tools/dispatch-lanes.js';
import { _internals as triggerInternals } from '../../../src/tools/write-pr-review-trigger-eval.js';
import { bunSpawn } from '../../../src/utils/bun-compat.js';
import { createIssue2469HostClient } from '../../helpers/issue-2469-registered-host.js';
import { bootKnowledgeHost } from '../../helpers/knowledge-real-host.js';
import {
	artifactRecord,
	reviewedRow,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

/**
 * Issue #2586 (AC11 / DD-C018 scenario a) — REAL-filesystem pin of the
 * post-settle mutation blocking stack, with NO digest/clean/HEAD seam mocked.
 * A real committed repository settles the registered journey against the real
 * digest, then the REAL repository state is mutated three ways. Qualification
 * finding: the blocking stack is layered — a dirty tree (tracked or
 * untracked) blocks at the clean-checkout gate, a committed move blocks at
 * the HEAD-match gate; each blocks only until the settled state is restored
 * (truthful-INCOMPLETE; honest blocking, never an invented terminal). The
 * inner digest re-LIVE corner stays mock-covered by
 * pr-review-terminal-coverage-adversarial.test.ts as defense in depth.
 */

const SESSION_ID = 'r10-live-reblock-realfs';
const RUN_ID = 'r10-live-reblock-run';
const originals = {
	diffStats: gateInternals.resolvePrReviewDiffStats,
	diffStatsAsync: gateInternals.resolvePrReviewDiffStatsAsync,
	agents: dispatchInternals.getGeneratedAgentNames,
};
let directory = '';
let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>>;
let nextChild = 0;
let deliveredPrompts = new Map<string, string>();
let headSha = '';
let baseSha = '';

function parsed(value: string): Record<string, unknown> & { success: boolean } {
	return JSON.parse(value) as Record<string, unknown> & { success: boolean };
}

async function gitRun(args: string[]): Promise<string> {
	const proc = bunSpawn(['git', ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			proc.stdout.text(),
			proc.stderr.text(),
		]);
		if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr}`);
		return stdout.trim();
	} finally {
		try {
			proc.kill();
		} catch {
			// Best-effort cleanup.
		}
	}
}

async function removeTempDir(): Promise<void> {
	closeAllProjectDbs();
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await fs.rm(directory, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'EBUSY' && code !== 'ENOTEMPTY') throw error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}

function promptField(prompt: string, name: string): string {
	const value = prompt.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1]?.trim();
	if (!value) throw new Error(`missing ${name} in rendered child prompt`);
	return value;
}

async function finishLane(record: ReturnType<typeof findByBatchId>[number]) {
	const header =
		record.mode === 'swarm-pr-review:micro'
			? CANDIDATE_HEADERS.micro_lane
			: record.mode === 'swarm-pr-review:base'
				? CANDIDATE_HEADERS.base_explorer
				: null;
	const text = header
		? `${header}\n[CLEAN] | ${record.workflowLane} | exact bound diff | registered child found no actionable defect`
		: reviewedRow('CLEAN-REVIEW', 'DISPROVED', 'NONE');
	const stored = storeLaneOutput(directory, {
		batchId: record.batchId!,
		laneId: record.laneId!,
		agent: record.swarmPrefixedAgent,
		role: record.normalizedAgent,
		sessionId: record.subagentSessionId,
		parentSessionId: SESSION_ID,
		mode: record.mode,
		workflowLane: record.workflowLane,
		prHeadSha: headSha,
		gitHead: headSha,
		revisionDigest: promptField(
			deliveredPrompts.get(record.subagentSessionId) ?? '',
			'revision_digest',
		),
		scope: record.workspace?.scope ?? undefined,
		source: 'collect_lane_results',
		text,
	});
	const terminal = await claimTerminalResult(directory, record.correlationId, {
		eventId: `r10-${record.correlationId}`,
		status: 'completed',
		recordedAt: 1,
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			...(stored.ref ? { outputRef: stored.ref } : {}),
		},
	});
	expect(terminal?.disposition).toBe('claimed');
}

async function submitAndFinish(batchId: string): Promise<void> {
	for (const record of findByBatchId(directory, batchId, SESSION_ID)) {
		const prompt = deliveredPrompts.get(record.subagentSessionId);
		if (!prompt) throw new Error('missing rendered child prompt');
		const owned =
			prompt
				.match(/^owned_workflow_lanes: (.+?) —/m)?.[1]
				?.split(',')
				.map((lane) => lane.trim()) ?? undefined;
		const envelopeLanes = owned ?? [promptField(prompt, 'workflow_lane')];
		const result = parsed(
			String(
				await plugin.tool.submit_pr_review_result.execute(
					{
						schemaVersion: 1,
						batchId: promptField(prompt, 'batch_id'),
						laneId: promptField(prompt, 'lane_id'),
						revisionDigest: promptField(prompt, 'revision_digest'),
						result: {
							schemaVersion: 1,
							outcome: 'CLEAN',
							creditedLanes: envelopeLanes,
							findings: [],
							cleanAttestations: envelopeLanes.map((workflowLane) => ({
								coverageScope: `Complete ${workflowLane} surface on the bound diff.`,
								evidence: 'Registered child found no actionable defect.',
								workflowLane,
							})),
							unresolved: [],
						},
					},
					{ directory, sessionID: record.subagentSessionId },
				),
			),
		);
		expect(result).toMatchObject({ success: true, status: 'recorded' });
		await finishLane(record);
	}
}

async function dispatch(
	batchId: string,
	mode: 'swarm-pr-review:base' | 'swarm-pr-review:micro',
	workflowLanes: readonly (string | readonly string[])[],
	triggerEvaluation?: PrReviewInlineTriggerRow[],
): Promise<void> {
	const lanes = workflowLanes.map((entry, index) => {
		const owned = typeof entry === 'string' ? [entry] : [...entry];
		return {
			id: `${mode.endsWith(':base') ? 'base' : 'micro'}-${index}`,
			agent: 'explorer',
			prompt: `Review ${owned.join(', ')} on the exact bound diff.`,
			workflow_lane: owned[0]!,
			...(owned.length > 1 ? { owned_workflow_lanes: owned } : {}),
		};
	});
	const result = parsed(
		String(
			await plugin.tool.dispatch_lanes_async.execute(
				{
					batch_id: batchId,
					mode,
					pr_head_sha: headSha,
					base_sha: baseSha,
					base_ref: 'origin/main',
					max_concurrent: lanes.length,
					...(triggerEvaluation
						? { trigger_evaluation: triggerEvaluation }
						: {}),
					lanes,
				},
				{ directory, sessionID: SESSION_ID },
			),
		),
	);
	expect(result).toMatchObject({ success: true, pending: lanes.length });
}

/** Settle the full registered journey against the real clean-tree digest. */
async function settleJourney(): Promise<void> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
		prHeadSha: headSha,
	});
	await dispatch('r10-base', 'swarm-pr-review:base', [
		PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 2),
		PR_REVIEW_BASE_DIMENSION_IDS.slice(2, 4),
		PR_REVIEW_BASE_DIMENSION_IDS.slice(4),
	]);
	await submitAndFinish('r10-base');
	expect(PR_REVIEW_REQUIRED_TRIGGER_IDS).toHaveLength(11);
	const inlineTriggers: PrReviewInlineTriggerRow[] =
		PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map((triggerId) => ({
			trigger_id: triggerId,
			result: 'MATCHED',
			evidence: `The bound diff requires focused review for ${triggerId}.`,
		}));
	const triggerRows: Array<Record<string, string>> = [];
	for (const [offset, lane] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		const batchId = `r10-micro-${offset}`;
		await dispatch(
			batchId,
			'swarm-pr-review:micro',
			[lane],
			offset === 0 ? inlineTriggers : undefined,
		);
		await submitAndFinish(batchId);
		for (const record of findByBatchId(directory, batchId, SESSION_ID)) {
			triggerRows.push({
				trigger_id: record.workflowLane!,
				result: 'MATCHED',
				evidence: `Registered micro receipt covers ${record.workflowLane}.`,
				source_batch_id: batchId,
				source_lane_id: record.laneId!,
			});
		}
	}
	const trigger = parsed(
		String(
			await plugin.tool.write_pr_review_trigger_eval.execute(
				{
					run_id: RUN_ID,
					pr_head_sha: headSha,
					base_ref: 'origin/main',
					base_sha: baseSha,
					rows: triggerRows,
				},
				{ directory, sessionID: SESSION_ID },
			),
		),
	);
	expect(trigger).toMatchObject({ success: true, matched_count: 11 });
	const explorer = parsed(
		String(
			await plugin.tool.write_pr_review_artifact.execute(
				{
					kind: 'findings',
					run_id: RUN_ID,
					pr_head_sha: headSha,
					boundary: 'post_explorer',
					records: [
						artifactRecord(
							'CLEAN-REVIEW',
							'PENDING',
							'route_to_reviewer',
							'NONE',
						),
					],
				},
				{ directory, sessionID: SESSION_ID },
			),
		),
	);
	expect(explorer.success).toBe(true);
	const reviewer = parsed(
		String(
			await plugin.tool.dispatch_lanes_async.execute(
				{
					batch_id: 'r10-reviewer',
					mode: 'swarm-pr-review:reviewer',
					pr_head_sha: headSha,
					base_sha: baseSha,
					base_ref: 'origin/main',
					max_concurrent: 1,
					lanes: [
						{
							id: 'r10-reviewer-lane',
							agent: 'reviewer',
							prompt: 'Classify the clean-review sentinel.',
							workflow_lane: 'r10-reviewer-lane',
							review_item_ids: ['CLEAN-REVIEW'],
						},
					],
				},
				{ directory, sessionID: SESSION_ID },
			),
		),
	);
	expect(reviewer.success).toBe(true);
	await finishLane(findByBatchId(directory, 'r10-reviewer', SESSION_ID)[0]!);
	for (const boundary of ['post_reviewer', 'post_critic'] as const) {
		const write = parsed(
			String(
				await plugin.tool.write_pr_review_artifact.execute(
					{
						kind: 'findings',
						run_id: RUN_ID,
						pr_head_sha: headSha,
						boundary,
						records: [
							artifactRecord(
								'CLEAN-REVIEW',
								'DISPROVED',
								'suppress_with_reason',
								'NONE',
							),
						],
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		);
		expect(write.success).toBe(true);
	}
}

async function attemptCompletion(): Promise<
	Record<string, unknown> & {
		success: boolean;
		terminal_report?: { live_dimensions?: string[] };
	}
> {
	return JSON.parse(
		String(
			await plugin.tool.complete_pr_workflow.execute(
				{
					mode: 'PR_REVIEW',
					pr_head_sha: headSha,
					report_verdict: 'APPROVE',
				},
				{ directory, sessionID: SESSION_ID },
			),
		),
	);
}

function expectComplete(
	completion: Awaited<ReturnType<typeof attemptCompletion>>,
): void {
	expect(completion).toMatchObject({
		success: true,
		status: 'completed',
		gate_cleared: true,
		terminal_report: {
			kind: 'COMPLETE',
			unresolved_dimensions: [],
			live_dimensions: [],
		},
	});
}

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-review-r10-realfs-');
	await initializeGitRepository(directory);
	// Keep the temp repo byte-stable across platforms: no CRLF translation.
	await gitRun(['config', 'core.autocrlf', 'false']);
	// The activated workflow writes its project config under .opencode/; keep
	// it out of the real clean-tree read exactly like the .swarm/ runtime root.
	await fs.writeFile(
		path.join(directory, '.git', 'info', 'exclude'),
		'.swarm/\n.opencode/\n',
	);
	await gitRun(['config', 'user.email', 'r10@example.invalid']);
	await gitRun(['config', 'user.name', 'r10 fixture']);
	await fs.writeFile(path.join(directory, 'tracked.txt'), 'baseline\n');
	await gitRun(['add', '-A']);
	await gitRun(['commit', '--quiet', '-m', 'base commit']);
	baseSha = await gitRun(['rev-parse', 'HEAD']);
	await fs.writeFile(path.join(directory, 'tracked.txt'), 'baseline\nsecond\n');
	await gitRun(['add', '-A']);
	await gitRun(['commit', '--quiet', '-m', 'head commit']);
	headSha = await gitRun(['rev-parse', 'HEAD']);
	// The real merge-base resolution requires the remote-tracking form
	// origin/<base_ref>; a local ref pointing at the base commit satisfies it
	// without any network remote.
	await gitRun(['update-ref', 'refs/remotes/origin/main', baseSha]);
	expect(await gitRun(['status', '--porcelain'])).toBe('');
	nextChild = 0;
	deliveredPrompts = new Map();
	gateInternals.resetTrackedStateCache();
	// Deliberately NOT overridden: resolveCurrentGitHead(Async),
	// resolvePrWorkflowRevisionDigest(Detailed)(Async), resolveIsWorkingTreeClean
	// (Async), resolveExactMergeBaseAsync, loadPluginConfig — the real-fs paths
	// under test. Only tier sizing and generated agent names stay controlled.
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 400,
		changedFiles: 12,
		hasSubmoduleChange: false,
	});
	gateInternals.resolvePrReviewDiffStatsAsync = (...args) =>
		gateInternals.resolvePrReviewDiffStats(...args);
	dispatchInternals.getGeneratedAgentNames = () => ['explorer', 'reviewer'];
	plugin = await bootKnowledgeHost(
		directory,
		{},
		createIssue2469HostClient({
			nextChildId: () => `r10-child-${++nextChild}`,
			onPrompt: (sessionID, prompt) => deliveredPrompts.set(sessionID, prompt),
		}),
	);
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolvePrReviewDiffStats = originals.diffStats;
	gateInternals.resolvePrReviewDiffStatsAsync = originals.diffStatsAsync;
	dispatchInternals.getGeneratedAgentNames = originals.agents;
	await removeTempDir();
});

describe('r10 LIVE re-block through the REAL worktree (issue 2586, DD-C018 scenario a)', () => {
	test('tracked-file mutation after settle blocks completion at the real clean-checkout gate until restored', async () => {
		await settleJourney();
		// REAL mutation after settle: the outer clean-checkout gate must refuse.
		await fs.appendFile(path.join(directory, 'tracked.txt'), 'mutation\n');
		const blocked = await attemptCompletion();
		expect(blocked.success).toBe(false);
		expect(JSON.stringify(blocked)).toContain(
			'requires a clean index and working tree',
		);
		// Restore the exact tree; completion succeeds with zero live lanes.
		await gitRun(['checkout', '--', 'tracked.txt']);
		expect(await gitRun(['status', '--porcelain'])).toBe('');
		expectComplete(await attemptCompletion());
	}, 120_000);

	test('untracked-only mutation also blocks — the real clean read is untracked-aware', async () => {
		await settleJourney();
		await fs.writeFile(path.join(directory, 'untracked-note.txt'), 'drift');
		const blocked = await attemptCompletion();
		expect(blocked.success).toBe(false);
		expect(JSON.stringify(blocked)).toContain(
			'requires a clean index and working tree',
		);
		await fs.rm(path.join(directory, 'untracked-note.txt'));
		const completion = await attemptCompletion();
		expect(completion.success).toBe(true);
		expect(completion.status).toBe('completed');
	}, 120_000);

	test('COMMITTED drift (clean tree, moved HEAD) blocks at the real HEAD-match gate until restored', async () => {
		await settleJourney();
		// Committed move: clean tree, moved HEAD — the exact-head binding
		// refuses; the digest corner behind it stays defense in depth.
		await fs.appendFile(path.join(directory, 'tracked.txt'), 'committed\n');
		await gitRun(['add', '-A']);
		await gitRun(['commit', '--quiet', '-m', 'post-settle drift commit']);
		expect(await gitRun(['status', '--porcelain'])).toBe('');
		const blocked = await attemptCompletion();
		expect(blocked.success).toBe(false);
		expect(JSON.stringify(blocked)).toContain('does not match PR head');
		// Returning to the settled head restores the binding and completes.
		await gitRun(['reset', '--hard', headSha]);
		expect(await gitRun(['status', '--porcelain'])).toBe('');
		expectComplete(await attemptCompletion());
	}, 120_000);
});
