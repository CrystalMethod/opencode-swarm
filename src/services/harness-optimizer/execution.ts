/**
 * Substrate execution bridge for the governed HarnessOpt capstone
 * (issue #2503). Materializes the simplified task descriptors into the
 * frozen, content-addressed evaluation substrate contract
 * (EvaluationTaskV1 + EvaluationCandidateV1 under a content-addressed
 * input root) and executes through the real production path
 * `evaluateCandidateV1` — never a parallel scorer.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	computeCandidateInputContentHash,
	computeTaskInputContentHash,
} from '../../evaluation/hashing.js';
import { evaluateCandidateV1 } from '../../evaluation/public-api.js';
import type { EvaluationExecutorResult } from '../../evaluation/runner.js';
import { sha256 } from '../../harness/hash.js';
import {
	type ComparativeExecutor,
	type ComparativeExecutorResult,
	type ComparativeTaskDescriptor,
	computeTaskPopulationHash,
} from './comparative.js';

export interface HarnessOptTaskSetDescriptor {
	split: 'train' | 'validation' | 'test';
	seed: string;
	tasks: ComparativeTaskDescriptor[];
}

export interface TokenUsage {
	tokens_input: number | 'unknown';
	tokens_cache: number | 'unknown';
	tokens_output: number | 'unknown';
}

export function harnessOptTaskSetRoot(
	projectRoot: string,
	taskSetHash: string,
): string {
	return path.join(
		projectRoot,
		'.swarm',
		'evolution',
		'harness-opt',
		'tasksets',
		taskSetHash,
	);
}

/**
 * Materialize the task-set input root (content-addressed by the task
 * population hash). Existing materialization is left untouched — the
 * content hash pins it; a mutation is detected by re-hashing before use.
 */
export function materializeHarnessOptInput(args: {
	projectRoot: string;
	descriptor: HarnessOptTaskSetDescriptor;
}): { inputRoot: string; taskSetHash: string } {
	const taskSetHash = computeTaskPopulationHash(args.descriptor.tasks);
	const inputRoot = harnessOptTaskSetRoot(args.projectRoot, taskSetHash);
	fs.mkdirSync(inputRoot, { recursive: true });
	fs.writeFileSync(
		path.join(inputRoot, 'baseline.md'),
		`baseline payload for ${args.descriptor.seed}\n`,
	);
	fs.writeFileSync(
		path.join(inputRoot, 'candidate.md'),
		`candidate payload for ${args.descriptor.seed}\n`,
	);
	for (const task of args.descriptor.tasks) {
		const taskDir = path.join(inputRoot, task.id);
		fs.mkdirSync(path.join(taskDir, 'fixture'), { recursive: true });
		fs.writeFileSync(
			path.join(taskDir, 'instruction.md'),
			`${task.instruction}\n`,
		);
		fs.writeFileSync(
			path.join(taskDir, 'fixture', 'subject.ts'),
			'export const value = 1;\n',
		);
	}
	return { inputRoot, taskSetHash };
}

export class HarnessOptInputTamperedError extends Error {
	readonly code = 'HARNESS_OPT_INPUT_TAMPERED';
	constructor(taskSetHash: string) {
		super(
			`materialized harness-opt task-set input no longer matches its content-addressed hash ${taskSetHash}`,
		);
		this.name = 'HarnessOptInputTamperedError';
	}
}

/**
 * Verify the MATERIALIZED ON-DISK input still matches its content-addressed
 * hash: re-reads every task instruction from the content-addressed input
 * root and recomputes the task-population hash from the bytes on disk. A
 * tampered materialization fails typed. (Issue #2503 integrity check.)
 */
export function verifyHarnessOptInput(args: {
	inputRoot: string;
	taskIds: readonly string[];
	taskSetHash: string;
}): boolean {
	const onDiskTasks = args.taskIds.map((taskId) => {
		const instructionPath = path.join(args.inputRoot, taskId, 'instruction.md');
		const instruction = fs.existsSync(instructionPath)
			? fs.readFileSync(instructionPath, 'utf8').replace(/\n$/, '')
			: '';
		return { id: taskId, instruction };
	});
	return computeTaskPopulationHash(onDiskTasks) === args.taskSetHash;
}

export interface SubstrateExecutionResult {
	runStatus: string;
	decisionStatus: string;
	decisionId: string;
	/** Host-reported USD spend accumulated across executor invocations. */
	reportedSpendUsd: number;
	outcomes: Array<{ candidateId: string; outcome: string }>;
	tokens: TokenUsage;
}

function toExecutorResult(
	result: ComparativeExecutorResult,
): EvaluationExecutorResult {
	if (result.status === 'transient_error') {
		return {
			status: 'infrastructure_failure',
			text: '',
			durationMs: 1,
			cost: { source: 'reported', usd: 0 },
			error: 'transient_error',
		};
	}
	return {
		status: 'completed',
		text: result.text,
		durationMs: 1,
		cost:
			typeof result.costUsd === 'number'
				? { source: 'reported', usd: result.costUsd }
				: { source: 'reported', usd: 0 },
	};
}

/**
 * Execute one governed evaluation round through the production substrate.
 * The simplified executor runs inside the substrate's disposable worktree
 * (isolatedRoot — never the running checkout) and token usage reported by
 * the host executor is captured; missing host data stays 'unknown'.
 */
export async function runSubstrateEvaluation(args: {
	projectRoot: string;
	inputRoot: string;
	descriptor: HarnessOptTaskSetDescriptor;
	seed: string;
	decidedAt: string;
	maxTransientRetries?: number;
	maxSpendUsd?: number;
	executor: ComparativeExecutor;
	abortSignal?: AbortSignal;
}): Promise<SubstrateExecutionResult> {
	const tokenUsage: TokenUsage = {
		tokens_input: 'unknown',
		tokens_cache: 'unknown',
		tokens_output: 'unknown',
	};
	let reportedSpendUsd = 0;
	const seedSalt = sha256(`${args.descriptor.seed}:${args.seed}`);
	const taskDrafts = args.descriptor.tasks.map((task) => ({
		v: 1 as const,
		id: task.id,
		source: 'curated' as const,
		split: args.descriptor.split,
		category: 'correctness',
		protected: true,
		instructionPath: path.join(task.id, 'instruction.md'),
		environment: {
			kind: 'fixture' as const,
			path: path.join(task.id, 'fixture'),
		},
		scorer: {
			kind: 'builtin' as const,
			argv: ['builtin'],
			timeoutMs: 10_000,
			scoreRange: [0, 1] as [number, number],
		},
		provenance: { origin: 'harness-opt', license: 'MIT' },
	}));
	const baselineDraft = {
		v: 1 as const,
		id: `harnessopt-baseline-${seedSalt.slice(0, 12)}`,
		kind: 'baseline' as const,
		payloadPath: 'baseline.md',
		model: 'configured',
	};
	const candidateDraft = {
		v: 1 as const,
		id: `harnessopt-candidate-${seedSalt.slice(0, 12)}`,
		kind: 'harness' as const,
		payloadPath: 'candidate.md',
		model: 'configured',
	};
	const tasks = await Promise.all(
		taskDrafts.map(async (draft) => ({
			...draft,
			contentHash: await computeTaskInputContentHash(args.inputRoot, draft),
		})),
	);
	const baseline = {
		...baselineDraft,
		contentHash: await computeCandidateInputContentHash(
			args.inputRoot,
			baselineDraft,
		),
	};
	const candidate = {
		...candidateDraft,
		contentHash: await computeCandidateInputContentHash(
			args.inputRoot,
			candidateDraft,
		),
	};
	const substrateExecutor = async (invocation: {
		task: { id: string };
		candidate: { kind: string };
		isolatedRoot: string;
		instruction: string;
		payload: string;
		seed: string;
		abortSignal: AbortSignal;
		projectRoot: string;
	}): Promise<EvaluationExecutorResult> => {
		const result = await args.executor({
			cwd: invocation.isolatedRoot,
			arm: invocation.candidate.kind === 'baseline' ? 'baseline' : 'candidate',
			taskId: invocation.task.id,
			instruction: invocation.instruction,
			payload: invocation.payload,
			seed: invocation.seed,
			abortSignal: invocation.abortSignal,
			projectRoot: invocation.projectRoot,
		});
		if (result.tokens) {
			if (typeof result.tokens.input === 'number')
				tokenUsage.tokens_input = result.tokens.input;
			if (typeof result.tokens.cache === 'number')
				tokenUsage.tokens_cache = result.tokens.cache;
			if (typeof result.tokens.output === 'number')
				tokenUsage.tokens_output = result.tokens.output;
		}
		if (typeof result.costUsd === 'number') reportedSpendUsd += result.costUsd;
		return toExecutorResult(result);
	};
	const { run, decision } = await evaluateCandidateV1({
		projectRoot: args.projectRoot,
		inputRoot: args.inputRoot,
		tasks,
		baseline,
		candidate,
		split: args.descriptor.split,
		seed: args.seed,
		models: ['configured'],
		budgets: {
			maxTasks: Math.max(1, args.descriptor.tasks.length),
			maxRepetitions: 1,
			maxConcurrency: 2,
			maxTaskTimeMs: 60_000,
			maxRetries: args.maxTransientRetries ?? 0,
			maxOutputBytes: 262_144,
			maxSpendUsd: args.maxSpendUsd,
		},
		decidedAt: args.decidedAt,
		executor: substrateExecutor,
		abortSignal: args.abortSignal,
	});
	return {
		runStatus: run.status,
		decisionStatus: decision.status,
		decisionId: decision.decisionId,
		reportedSpendUsd,
		outcomes: run.results.map((result) => ({
			candidateId: result.candidateId,
			outcome: result.outcome,
		})),
		tokens: tokenUsage,
	};
}
