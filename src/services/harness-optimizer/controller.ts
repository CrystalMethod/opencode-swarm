/**
 * Governed serial round controller for the HarnessOpt capstone (issue
 * #2503). One allowlisted candidate per round; the round executes through
 * the production evaluation substrate inside its disposable worktree (the
 * running checkout is fingerprint-verified unchanged); held-out splits are
 * consumed exactly once by the SUBSTRATE (`claimHeldOutTest`), never by
 * this controller; every round is recorded as durable lineage with
 * task-cost accounting (unknown-not-zero); transient retries are bounded;
 * and pilot graduation keeps negative evidence verbatim.
 *
 * The controller never activates, rolls back, or mutates the live harness:
 * activation and rollback stay on the existing human-only
 * `/swarm approve-write` + harness store path.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { canonicalJson, sha256 } from '../../harness/hash.js';
import { atomicWriteSwarmFile } from '../../utils/atomic-write.js';
import type {
	ComparativeExecutor,
	ComparativeTaskDescriptor,
} from './comparative.js';
import { computeTaskPopulationHash } from './comparative.js';
import {
	materializeHarnessOptInput,
	runSubstrateEvaluation,
} from './execution.js';
import {
	computeCandidateConfigDigest,
	computePromptSelectionDigest,
	recordHarnessOptRound,
} from './lineage.js';

export type HarnessOptSplit = 'train' | 'validation' | 'test';

export type HarnessOptStopReason =
	| 'completed'
	| 'inconclusive'
	| 'transient_retry_budget_exhausted'
	| 'round_budget_exhausted'
	| 'wall_clock_budget_exhausted'
	| 'spend_budget_exhausted'
	| 'equivalent_patch_convergence'
	| 'digest_repeat'
	| 'integrity_failure'
	| 'heldout_consumed'
	| 'stopped_by_operator';

export interface HarnessOptRoundResult {
	stopReason: HarnessOptStopReason;
	transientRetries: number;
	roundId: string;
	roundCounter: number;
	saltedSeed: string;
	taskSetHash: string;
	decision: { status: string; decisionId: string };
}

interface HarnessOptState {
	v: 1;
	roundCounter: number;
	taskSets: Record<string, string>;
	stopReason: string | null;
}

export class FrozenTaskSetMismatchError extends Error {
	readonly code = 'FROZEN_CONTENT_MISMATCH';
	constructor(key: string) {
		super(
			`task-set key ${key} is already frozen with different content (FROZEN_CONTENT_MISMATCH)`,
		);
		this.name = 'FrozenTaskSetMismatchError';
	}
}

const LOCK_RETRY = {
	retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
};

function harnessOptRoot(projectRoot: string): string {
	return path.join(projectRoot, '.swarm', 'evolution', 'harness-opt');
}

function statePath(projectRoot: string): string {
	return path.join(harnessOptRoot(projectRoot), 'state.json');
}

function loadState(projectRoot: string): HarnessOptState {
	if (!existsSync(statePath(projectRoot))) {
		return { v: 1, roundCounter: 0, taskSets: {}, stopReason: null };
	}
	return JSON.parse(
		readFileSync(statePath(projectRoot), 'utf8'),
	) as HarnessOptState;
}

async function withHarnessOptLock<T>(
	projectRoot: string,
	work: () => Promise<T>,
): Promise<T> {
	mkdirSync(harnessOptRoot(projectRoot), { recursive: true });
	const release = (await (
		lockfile as unknown as {
			lock: (
				target: string,
				options: {
					retries: typeof LOCK_RETRY;
					stale: number;
					realpath: boolean;
				},
			) => Promise<() => Promise<void>>;
		}
	).lock(harnessOptRoot(projectRoot), {
		retries: LOCK_RETRY,
		stale: 5_000,
		realpath: false,
	})) as () => Promise<void>;
	try {
		return await work();
	} finally {
		await release().catch(() => {});
	}
}

function taskSetKey(split: HarnessOptSplit, seed: string): string {
	return `${split}:${sha256(seed)}`;
}

/**
 * Content-freeze the task set BEFORE any round. Re-freezing the same
 * {split, seed} key with mutated task content is rejected (typed
 * FROZEN_CONTENT_MISMATCH); identical content is idempotent. The frozen
 * input lives content-addressed under .swarm/evolution/harness-opt/ and
 * the substrate's immutable admission backs the freeze for non-train
 * splits.
 */
export async function freezeHarnessOptTaskSet(args: {
	projectRoot: string;
	tasks: ComparativeTaskDescriptor[];
	split: HarnessOptSplit;
	seed: string;
}): Promise<
	| { ok: true; contentHash: string }
	| { ok: false; code: 'FROZEN_CONTENT_MISMATCH'; reason: string }
> {
	return withHarnessOptLock(args.projectRoot, async () => {
		const state = loadState(args.projectRoot);
		const key = taskSetKey(args.split, args.seed);
		const contentHash = computeTaskPopulationHash(args.tasks);
		const existing = state.taskSets[key];
		if (existing !== undefined && existing !== contentHash) {
			return {
				ok: false as const,
				code: 'FROZEN_CONTENT_MISMATCH' as const,
				reason: `task-set key ${key} is frozen as ${existing} but the supplied tasks hash to ${contentHash}`,
			};
		}
		if (existing === undefined) {
			materializeHarnessOptInput({
				projectRoot: args.projectRoot,
				descriptor: { split: args.split, seed: args.seed, tasks: args.tasks },
			});
			state.taskSets[key] = contentHash;
			await atomicWriteSwarmFile(
				statePath(args.projectRoot),
				`${JSON.stringify(state, null, '\t')}\n`,
			);
		}
		return { ok: true as const, contentHash };
	});
}

/**
 * Execute ONE governed optimization round. The per-round seed salt
 * `${seed}#roundNNNNNN` guarantees a fresh substrate runId per round, so
 * the SUBSTRATE's claimHeldOutTest is what surfaces
 * TestAlreadyConsumedError on a second held-out round over the same
 * frozen task set — the controller never masks consumption with its own
 * counter.
 */
export async function runHarnessOptRound(args: {
	projectRoot: string;
	tasks: ComparativeTaskDescriptor[];
	split: HarnessOptSplit;
	seed: string;
	maxTransientRetries?: number;
	executor: ComparativeExecutor;
	abortSignal?: AbortSignal;
}): Promise<HarnessOptRoundResult> {
	return withHarnessOptLock(args.projectRoot, async () => {
		const state = loadState(args.projectRoot);
		if (state.stopReason) {
			throw new Error(
				`harness-opt loop is stopped (${state.stopReason}); clear the stop with harness-opt plan before running`,
			);
		}
		const key = taskSetKey(args.split, args.seed);
		const contentHash = computeTaskPopulationHash(args.tasks);
		const existing = state.taskSets[key];
		if (existing !== undefined && existing !== contentHash) {
			throw new FrozenTaskSetMismatchError(key);
		}
		if (existing === undefined) {
			materializeHarnessOptInput({
				projectRoot: args.projectRoot,
				descriptor: {
					split: args.split,
					seed: args.seed,
					tasks: args.tasks,
				},
			});
			state.taskSets[key] = contentHash;
		}
		state.roundCounter += 1;
		const roundCounter = state.roundCounter;
		const saltedSeed = `${args.seed}#round${String(roundCounter).padStart(6, '0')}`;
		await atomicWriteSwarmFile(
			statePath(args.projectRoot),
			`${JSON.stringify(state, null, '\t')}\n`,
		);
		const inputRoot = path.join(
			harnessOptRoot(args.projectRoot),
			'tasksets',
			contentHash,
		);
		const decidedAt = new Date().toISOString();
		const maxTransientRetries = args.maxTransientRetries ?? 0;
		const result = await runSubstrateEvaluation({
			projectRoot: args.projectRoot,
			inputRoot,
			descriptor: {
				split: args.split,
				seed: args.seed,
				tasks: args.tasks,
			},
			seed: saltedSeed,
			decidedAt,
			maxTransientRetries,
			executor: args.executor,
			abortSignal: args.abortSignal,
		});
		const candidateOutcomes = result.outcomes.filter(
			(outcome) => !outcome.candidateId.startsWith('harnessopt-baseline-'),
		);
		const allInfrastructure = candidateOutcomes.every(
			(outcome) => outcome.outcome === 'infrastructure_failure',
		);
		const artifactOutcome =
			result.decisionStatus === 'accept'
				? 'accepted'
				: result.decisionStatus === 'reject'
					? 'rejected'
					: 'inconclusive';
		const roundId = `round-${sha256(saltedSeed).slice(0, 16)}`;
		await recordHarnessOptRound({
			projectRoot: args.projectRoot,
			record: {
				v: 1,
				roundId,
				replayLineageId: roundId,
				recordedAt: decidedAt,
				split: args.split,
				baseSeed: args.seed,
				saltedSeed,
				roundCounter,
				taskSetHash: contentHash,
				candidateConfigDigest: computeCandidateConfigDigest({
					saltedSeed,
					split: args.split,
					maxTransientRetries,
				}),
				promptSelectionDigest: computePromptSelectionDigest(args.tasks),
				tokens_input: result.tokens.tokens_input,
				tokens_cache: result.tokens.tokens_cache,
				tokens_output: result.tokens.tokens_output,
				artifactOutcome,
				decision: {
					status: result.decisionStatus,
					decisionId: result.decisionId,
				},
				execution: {
					decidedAt,
					maxTransientRetries,
					tasks: args.tasks,
				},
			},
		});
		const stopReason: HarnessOptStopReason = allInfrastructure
			? 'transient_retry_budget_exhausted'
			: result.decisionStatus === 'inconclusive'
				? 'inconclusive'
				: 'completed';
		return {
			stopReason,
			transientRetries: allInfrastructure ? maxTransientRetries : 0,
			roundId,
			roundCounter,
			saltedSeed,
			taskSetHash: contentHash,
			decision: {
				status: result.decisionStatus,
				decisionId: result.decisionId,
			},
		};
	});
}

export interface PilotGraduationRecord {
	v: 1;
	recordId: string;
	eligible: boolean;
	evaluatedAt: string;
	criteria: { lowerCiThreshold: number };
	evidence: {
		improvementLowerCi: number;
		protectedRegressions: string[];
	};
}

function pilotRecordPath(projectRoot: string, recordId: string): string {
	return path.join(
		harnessOptRoot(projectRoot),
		'pilots',
		recordId,
		'record.json',
	);
}

/**
 * Evaluate pilot graduation against the predeclared criteria. The evidence
 * — including failing (negative) evidence — is retained verbatim in the
 * durable record. Default flipping stays owned by #2504; this surface only
 * reports eligibility.
 */
export async function evaluatePilotGraduation(args: {
	projectRoot: string;
	criteria: { lowerCiThreshold: number };
	evidence: {
		improvementLowerCi: number;
		protectedRegressions: string[];
	};
}): Promise<{ eligible: boolean; recordId: string }> {
	const eligible =
		args.evidence.improvementLowerCi > args.criteria.lowerCiThreshold &&
		args.evidence.protectedRegressions.length === 0;
	const recordId = `pilot-${sha256(
		canonicalJson({ criteria: args.criteria, evidence: args.evidence }),
	).slice(0, 16)}`;
	const record: PilotGraduationRecord = {
		v: 1,
		recordId,
		eligible,
		evaluatedAt: new Date().toISOString(),
		criteria: args.criteria,
		evidence: args.evidence,
	};
	mkdirSync(path.dirname(pilotRecordPath(args.projectRoot, recordId)), {
		recursive: true,
	});
	await atomicWriteSwarmFile(
		pilotRecordPath(args.projectRoot, recordId),
		`${JSON.stringify(record, null, '\t')}\n`,
	);
	return { eligible, recordId };
}

export function loadPilotGraduationRecord(
	projectRoot: string,
	recordId: string,
): PilotGraduationRecord | null {
	const recordPath = pilotRecordPath(projectRoot, recordId);
	if (!existsSync(recordPath)) return null;
	return JSON.parse(readFileSync(recordPath, 'utf8')) as PilotGraduationRecord;
}

/** Human-only operator stop: halts further rounds until cleared by plan. */
export async function stopHarnessOptLoop(args: {
	projectRoot: string;
	reason: string;
}): Promise<{ stopped: true; reason: string }> {
	return withHarnessOptLock(args.projectRoot, async () => {
		const state = loadState(args.projectRoot);
		state.stopReason = args.reason;
		await atomicWriteSwarmFile(
			statePath(args.projectRoot),
			`${JSON.stringify(state, null, '\t')}\n`,
		);
		return { stopped: true, reason: args.reason };
	});
}

export interface HarnessOptStatus {
	roundCounter: number;
	stopped: boolean;
	stopReason: string | null;
	frozenTaskSets: number;
}

export function harnessOptStatus(projectRoot: string): HarnessOptStatus {
	const state = loadState(projectRoot);
	return {
		roundCounter: state.roundCounter,
		stopped: state.stopReason !== null,
		stopReason: state.stopReason,
		frozenTaskSets: Object.keys(state.taskSets).length,
	};
}
