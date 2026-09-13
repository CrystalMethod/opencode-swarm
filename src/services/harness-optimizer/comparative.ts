/**
 * Comparative evaluation protocol for the governed HarnessOpt capstone
 * (issue #2503): baseline, ablation, and simple-agent control arms run on
 * the SAME frozen task population with matched budgets; per-arm
 * denominators are reported and negative/failed arm results are RETAINED.
 *
 * Stream-snapshot guard: every arm carries a content digest of its input
 * stream; a digest duplicated inside one protocol run, or matching a
 * previously-recorded digest for the same task population, is rejected
 * with STREAM_SNAPSHOT_DUPLICATE — an improvement cannot be claimed from
 * a duplicated or cumulative stream snapshot.
 */
import { execFileSync } from 'node:child_process';
import { withDisposableWorktree } from '../../evaluation/disposable-worktree.js';
import { canonicalJson, sha256 } from '../../harness/hash.js';
import { resolveGitExecutable } from '../../utils/git-executable.js';

export type ComparativeArmKey = 'baseline' | 'ablation' | 'simple-agent';

export const COMPARATIVE_ARM_KEYS: readonly ComparativeArmKey[] = [
	'baseline',
	'ablation',
	'simple-agent',
];

export interface ComparativeTaskDescriptor {
	id: string;
	instruction: string;
}

export type ComparativeExecutorStatus =
	| 'completed'
	| 'transient_error'
	| 'failed';

export interface ComparativeExecutorResult {
	status: ComparativeExecutorStatus;
	text: string;
	tokens?: { input?: number; cache?: number; output?: number };
	/** Host-reported USD cost of this invocation, when supplied. */
	costUsd?: number;
}

export type ComparativeExecutor = (invocation: {
	cwd: string;
	/** Protocol arm, or the round-role labels baseline/candidate on substrate rounds. */
	arm: ComparativeArmKey | 'candidate';
	taskId: string;
	/** Host context passthrough (optional; populated on substrate-driven rounds). */
	instruction?: string;
	payload?: string;
	seed?: string;
	abortSignal?: AbortSignal;
	projectRoot?: string;
}) => Promise<ComparativeExecutorResult> | ComparativeExecutorResult;

export interface ComparativeArmResult {
	arm: ComparativeArmKey;
	taskPopulationHash: string;
	/** Denominator: every task in the population was attempted. */
	n: number;
	completed: number;
	failed: number;
	transientFailures: number;
	streamDigest: string;
	outcomes: Array<{ taskId: string; status: ComparativeExecutorStatus }>;
}

export interface ComparativeProtocolResult {
	arms: Record<ComparativeArmKey, ComparativeArmResult>;
	taskPopulationHash: string;
}

export class StreamSnapshotDuplicateError extends Error {
	readonly code = 'STREAM_SNAPSHOT_DUPLICATE';
	constructor(digest: string) {
		super(
			`stream snapshot digest ${digest} is duplicated; improvement cannot be claimed from a duplicated or cumulative stream snapshot`,
		);
		this.name = 'StreamSnapshotDuplicateError';
	}
}

export function computeTaskPopulationHash(
	tasks: readonly ComparativeTaskDescriptor[],
): string {
	return sha256(canonicalJson(tasks));
}

export function computeArmStreamDigest(args: {
	arm: ComparativeArmKey;
	seed: string;
	tasks: readonly ComparativeTaskDescriptor[];
}): string {
	return sha256(canonicalJson(args));
}

function resolveHeadCommit(projectRoot: string): string {
	return execFileSync(resolveGitExecutable(), ['rev-parse', 'HEAD'], {
		cwd: projectRoot,
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'ignore'],
	})
		.toString()
		.trim();
}

/**
 * Run the three comparative arms. Each arm executes the full task
 * population inside its own disposable git worktree (never the running
 * checkout), with the working-tree fingerprint verified unchanged by
 * withDisposableWorktree. Failed arms stay in the result with their
 * outcomes — negative results are evidence, not noise.
 */
export async function runComparativeProtocol(args: {
	projectRoot: string;
	tasks: ComparativeTaskDescriptor[];
	seed: string;
	executor: ComparativeExecutor;
	/** Previously-recorded digests for this task population; a repeat rejects. */
	previousStreamDigests?: string[];
	/**
	 * Arm toggles (harness_opt.run_ablation_arm / run_simple_agent_arm).
	 * The baseline arm always runs; unlisted arms are skipped and absent
	 * from the result. Defaults to all three arms.
	 */
	runAblationArm?: boolean;
	runSimpleAgentArm?: boolean;
	abortSignal?: AbortSignal;
}): Promise<ComparativeProtocolResult> {
	const taskPopulationHash = computeTaskPopulationHash(args.tasks);
	const seenDigests = new Set<string>(
		(args.previousStreamDigests ?? []).map((digest) => digest),
	);
	const arms = {} as Record<ComparativeArmKey, ComparativeArmResult>;
	const selectedArms = COMPARATIVE_ARM_KEYS.filter(
		(arm) =>
			arm === 'baseline' ||
			(arm === 'ablation' && args.runAblationArm !== false) ||
			(arm === 'simple-agent' && args.runSimpleAgentArm !== false),
	);
	for (const arm of selectedArms) {
		const streamDigest = computeArmStreamDigest({
			arm,
			seed: args.seed,
			tasks: args.tasks,
		});
		if (seenDigests.has(streamDigest)) {
			throw new StreamSnapshotDuplicateError(streamDigest);
		}
		seenDigests.add(streamDigest);
		const armResult = await withDisposableWorktree({
			projectRoot: args.projectRoot,
			baseRef: resolveHeadCommit(args.projectRoot),
			abortSignal: args.abortSignal,
			run: async (worktree) => {
				const outcomes: ComparativeArmResult['outcomes'] = [];
				let completed = 0;
				let failed = 0;
				let transientFailures = 0;
				for (const task of args.tasks) {
					const result = await args.executor({
						cwd: worktree.path,
						arm,
						taskId: task.id,
					});
					outcomes.push({ taskId: task.id, status: result.status });
					if (result.status === 'completed') completed += 1;
					else if (result.status === 'failed') failed += 1;
					else transientFailures += 1;
				}
				return {
					arm,
					taskPopulationHash,
					n: args.tasks.length,
					completed,
					failed,
					transientFailures,
					streamDigest,
					outcomes,
				} satisfies ComparativeArmResult;
			},
		});
		arms[arm] = armResult;
	}
	return { arms, taskPopulationHash };
}
