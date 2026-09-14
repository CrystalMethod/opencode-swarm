/**
 * Durable round lineage for the governed HarnessOpt capstone (issue #2503).
 *
 * Every governed round records: the candidate config digest, the prompt /
 * skill selection digest, task-cost accounting (tokens input/cache/output
 * where supplied by the host; missing data stays the literal string
 * 'unknown' — never zero), the replay lineage id, the artifact outcome,
 * and the recorded promotion decision. Replay re-executes through the
 * substrate with the RECORDED fully-salted seed and decidedAt — the
 * derived runId equals the original, so the substrate returns the same
 * immutable cached run and the replayed decision must equal the recorded
 * one or the replay fails typed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { canonicalJson, sha256 } from '../../harness/hash.js';
import { atomicWriteSwarmFile } from '../../utils/atomic-write.js';
import type { ComparativeTaskDescriptor } from './comparative.js';
import type { TokenUsage } from './execution.js';
import { harnessOptTaskSetRoot, runSubstrateEvaluation } from './execution.js';

export interface HarnessOptLineageRecord {
	v: 1;
	roundId: string;
	/** Identical to roundId: one identity string, no derived second id. */
	replayLineageId: string;
	recordedAt: string;
	split: 'train' | 'validation' | 'test';
	baseSeed: string;
	saltedSeed: string;
	roundCounter: number;
	taskSetHash: string;
	candidateConfigDigest: string;
	promptSelectionDigest: string;
	tokens_input: number | 'unknown';
	tokens_cache: number | 'unknown';
	tokens_output: number | 'unknown';
	artifactOutcome: string;
	oracle: { verdict: string; reasons: string[] };
	decision: { status: string; decisionId: string };
	execution: {
		decidedAt: string;
		maxTransientRetries?: number;
		tasks: ComparativeTaskDescriptor[];
	};
}

export class ReplayDecisionMismatchError extends Error {
	readonly code = 'REPLAY_DECISION_MISMATCH';
	constructor(recorded: string, replayed: string) {
		super(
			`replayed decision ${replayed} does not equal the recorded decision ${recorded}`,
		);
		this.name = 'ReplayDecisionMismatchError';
	}
}

function lineageRoundDir(projectRoot: string, roundId: string): string {
	return path.join(
		projectRoot,
		'.swarm',
		'evolution',
		'harness-opt',
		'rounds',
		roundId,
	);
}

export async function recordHarnessOptRound(args: {
	projectRoot: string;
	record: HarnessOptLineageRecord;
}): Promise<void> {
	const dir = lineageRoundDir(args.projectRoot, args.record.roundId);
	mkdirSync(dir, { recursive: true });
	await atomicWriteSwarmFile(
		path.join(dir, 'record.json'),
		`${JSON.stringify(args.record, null, '\t')}\n`,
	);
}

export function listHarnessOptLineage(
	projectRoot: string,
): HarnessOptLineageRecord[] {
	const roundsRoot = path.join(
		projectRoot,
		'.swarm',
		'evolution',
		'harness-opt',
		'rounds',
	);
	if (!existsSync(roundsRoot)) return [];
	const records: HarnessOptLineageRecord[] = [];
	for (const entry of readdirSync(roundsRoot)) {
		const recordPath = path.join(roundsRoot, entry, 'record.json');
		if (!existsSync(recordPath)) continue;
		try {
			records.push(
				JSON.parse(readFileSync(recordPath, 'utf8')) as HarnessOptLineageRecord,
			);
		} catch {
			// A corrupt record is skipped for listing; replay of that id fails
			// typed below. Never silently drop the failure surface entirely.
		}
	}
	records.sort((a, b) => a.roundCounter - b.roundCounter);
	return records;
}

export function loadHarnessOptLineageRecord(args: {
	projectRoot: string;
	roundId: string;
}): HarnessOptLineageRecord | null {
	const recordPath = path.join(
		lineageRoundDir(args.projectRoot, args.roundId),
		'record.json',
	);
	if (!existsSync(recordPath)) return null;
	return JSON.parse(
		readFileSync(recordPath, 'utf8'),
	) as HarnessOptLineageRecord;
}

export function computeCandidateConfigDigest(args: {
	saltedSeed: string;
	split: string;
	maxTransientRetries?: number;
}): string {
	return sha256(canonicalJson(args));
}

export function computePromptSelectionDigest(
	tasks: readonly ComparativeTaskDescriptor[],
): string {
	return sha256(
		canonicalJson(
			tasks.map((task) => ({ id: task.id, instruction: task.instruction })),
		),
	);
}

/**
 * Replay a recorded round. The recorded fully-salted seed and decidedAt are
 * re-used WITHOUT reading or advancing the round counter, so the substrate
 * derives the identical runId and returns the immutable cached run. The
 * replay executor throws if ever invoked — a replay must hit the cached
 * record, never re-spend execution. Any decision mismatch (a tampered or
 * stale record) fails typed.
 */
export async function replayHarnessOptLineage(args: {
	projectRoot: string;
	lineageId: string;
}): Promise<{ decision: { status: string; decisionId: string } }> {
	const record = loadHarnessOptLineageRecord({
		projectRoot: args.projectRoot,
		roundId: args.lineageId,
	});
	if (!record) {
		throw new Error(`harness-opt lineage record ${args.lineageId} not found`);
	}
	const inputRoot = harnessOptTaskSetRoot(args.projectRoot, record.taskSetHash);
	const replayed = await runSubstrateEvaluation({
		projectRoot: args.projectRoot,
		inputRoot,
		descriptor: {
			split: record.split,
			seed: record.baseSeed,
			tasks: record.execution.tasks,
		},
		seed: record.saltedSeed,
		decidedAt: record.execution.decidedAt,
		maxTransientRetries: record.execution.maxTransientRetries,
		executor: async () => {
			throw new Error(
				'REPLAY_EXECUTOR_INVOKED: replay must resolve to the cached immutable run',
			);
		},
	});
	if (replayed.decisionId !== record.decision.decisionId) {
		throw new ReplayDecisionMismatchError(
			record.decision.decisionId,
			replayed.decisionId,
		);
	}
	return {
		decision: {
			status: replayed.decisionStatus,
			decisionId: replayed.decisionId,
		},
	};
}

export type { TokenUsage };
