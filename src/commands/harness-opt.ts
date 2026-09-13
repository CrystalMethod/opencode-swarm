/**
 * `/swarm harness-opt` command group (issue #2503 — governed HarnessOpt
 * capstone).
 *
 * Subcommands: plan | run | status | stop | history
 *
 * - JSON output on `--json` (convention: skill-opt.ts).
 * - Disabled by default: `run` requires `config.harness_opt.enabled === true`
 *   AND an explicit `--confirm`. The `--confirm` refusal is evaluated FIRST
 *   so it stays observable without any config in the command context.
 * - `run` and `stop` are human-gated (`toolPolicy: 'human-only'` on the
 *   registry entries); `plan`/`status`/`history` are read-only/proposal-only.
 * - Activation and rollback are NOT here: they stay on the existing
 *   human-only `/swarm approve-write` + harness store path.
 * - `run` executes the round through the production evaluation substrate
 *   in a disposable worktree; a `test` split consumes the held-out set
 *   exactly once (substrate-enforced).
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	DEFAULT_HARNESS_OPT_CONFIG,
	type HarnessOptConfig,
	HarnessOptConfigSchema,
} from '../config/schema.js';
import type { EvaluationModelDispatcher } from '../evaluation/model-dispatcher.js';
import { createModelEvaluationExecutor } from '../evaluation/runner.js';
import type {
	ComparativeExecutor,
	ComparativeTaskDescriptor,
} from '../services/harness-optimizer/comparative.js';
import {
	freezeHarnessOptTaskSet,
	harnessOptStatus,
	runHarnessOptRound,
	stopHarnessOptLoop,
} from '../services/harness-optimizer/controller.js';
import { listHarnessOptLineage } from '../services/harness-optimizer/lineage.js';

interface ParsedHarnessOptArgs {
	json: boolean;
	confirm: boolean;
	tasksFile: string | undefined;
	split: 'train' | 'validation' | 'test';
	seed: string;
	reason: string | undefined;
}

function parseHarnessOptArgs(args: string[]): ParsedHarnessOptArgs {
	const json = args.includes('--json');
	const confirm = args.includes('--confirm');
	const flagValue = (flag: string): string | undefined => {
		const idx = args.indexOf(flag);
		return idx >= 0 ? args[idx + 1] : undefined;
	};
	const splitArg = flagValue('--split');
	const split =
		splitArg === 'train' || splitArg === 'test' ? splitArg : 'validation';
	return {
		json,
		confirm,
		tasksFile: flagValue('--tasks'),
		split,
		seed: flagValue('--seed') ?? 'harness-opt',
		reason: flagValue('--reason'),
	};
}

function emit(result: unknown, json: boolean): string {
	if (json) return JSON.stringify(result, null, 2);
	return `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
}

function resolveHarnessOptConfig(block: unknown): HarnessOptConfig {
	const parsed = HarnessOptConfigSchema.safeParse(block ?? {});
	return parsed.success ? parsed.data : { ...DEFAULT_HARNESS_OPT_CONFIG };
}

function readHarnessOptConfigFromProject(directory: string): HarnessOptConfig {
	// The config is normally injected via plugin load; for the CLI path read
	// opencode.json's harness_opt block best-effort (mirrors skill-opt).
	try {
		const cfgPath = path.join(directory, 'opencode.json');
		if (!existsSync(cfgPath)) return { ...DEFAULT_HARNESS_OPT_CONFIG };
		const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
		const block = (raw?.harness_opt ?? raw?.swarm?.harness_opt) as unknown;
		return resolveHarnessOptConfig(block);
	} catch {
		return { ...DEFAULT_HARNESS_OPT_CONFIG };
	}
}

export interface HarnessOptRuntime {
	config?: HarnessOptConfig;
	/** Evaluation dispatcher from CommandContext.evaluationModelDispatcher. */
	dispatcher?: EvaluationModelDispatcher;
	parentSessionId?: string;
}

function loadTasksFile(
	directory: string,
	tasksFile: string | undefined,
): { tasks: ComparativeTaskDescriptor[] } | { error: string } {
	if (!tasksFile) {
		return {
			error:
				'pass --tasks <project-relative-json> with an array of {id, instruction} task descriptors',
		};
	}
	const resolved = path.resolve(directory, tasksFile);
	if (!resolved.startsWith(path.resolve(directory))) {
		return { error: '--tasks path must stay inside the project root' };
	}
	if (!existsSync(resolved)) {
		return { error: `tasks file not found: ${tasksFile}` };
	}
	try {
		const parsed = JSON.parse(readFileSync(resolved, 'utf8')) as unknown;
		if (
			!Array.isArray(parsed) ||
			parsed.length === 0 ||
			!parsed.every(
				(entry) =>
					typeof entry === 'object' &&
					entry !== null &&
					typeof (entry as { id?: unknown }).id === 'string' &&
					typeof (entry as { instruction?: unknown }).instruction === 'string',
			)
		) {
			return {
				error: 'tasks file must be a non-empty array of {id, instruction}',
			};
		}
		return { tasks: parsed as ComparativeTaskDescriptor[] };
	} catch {
		return { error: `tasks file is not valid JSON: ${tasksFile}` };
	}
}

/**
 * Build the round executor for the command surface from the evaluation
 * model dispatcher (the same production executor skill-opt validation
 * uses). Host executor statuses map onto the simplified contract:
 * anything but a completion is a transient-class failure so the bounded
 * retry circuit owns it.
 */
function buildRoundExecutor(
	dispatcher: EvaluationModelDispatcher,
	parentSessionId: string | undefined,
): ComparativeExecutor {
	const substrateExecutor = createModelEvaluationExecutor(
		dispatcher,
		parentSessionId,
	);
	return async (invocation) => {
		const result = await substrateExecutor({
			task: {
				id: invocation.taskId,
				scorer: { timeoutMs: 60_000 },
			} as Parameters<typeof substrateExecutor>[0]['task'],
			candidate: {
				agent: 'reviewer',
				model: 'configured',
				kind: invocation.arm === 'baseline' ? 'baseline' : 'harness',
			} as Parameters<typeof substrateExecutor>[0]['candidate'],
			isolatedRoot: invocation.cwd,
			instruction: invocation.instruction ?? '',
			payload: invocation.payload ?? '',
			seed: invocation.seed ?? '',
			abortSignal: invocation.abortSignal ?? new AbortController().signal,
			projectRoot: invocation.projectRoot ?? invocation.cwd,
		});
		return {
			status: result.status === 'completed' ? 'completed' : 'transient_error',
			text: result.text,
		};
	};
}

/** `/swarm harness-opt plan` — freeze the task set and report (dry-run). */
export async function handleHarnessOptPlan(
	directory: string,
	args: string[],
	_runtime: HarnessOptRuntime = {},
): Promise<string> {
	const parsed = parseHarnessOptArgs(args);
	const loaded = loadTasksFile(directory, parsed.tasksFile);
	if ('error' in loaded) {
		return emit({ status: 'error', error: loaded.error }, parsed.json);
	}
	const frozen = await freezeHarnessOptTaskSet({
		projectRoot: directory,
		tasks: loaded.tasks,
		split: parsed.split,
		seed: parsed.seed,
	});
	const status = harnessOptStatus(directory);
	return emit(
		{
			status: 'ok',
			plan: 'dry-run (no round executed; run requires --confirm)',
			frozen,
			loop: status,
		},
		parsed.json,
	);
}

/** `/swarm harness-opt run` — execute ONE governed round (human-only). */
export async function handleHarnessOptRun(
	directory: string,
	args: string[],
	runtime: HarnessOptRuntime = {},
): Promise<string> {
	const parsed = parseHarnessOptArgs(args);
	if (!parsed.confirm) {
		return emit(
			{
				status: 'needs-confirm',
				error:
					'pass --confirm to execute a governed round (a test split consumes the held-out set exactly once)',
			},
			parsed.json,
		);
	}
	const config = runtime.config ?? readHarnessOptConfigFromProject(directory);
	if (!config.enabled) {
		return emit(
			{
				status: 'disabled',
				error:
					'harness_opt.enabled is false — set to true to execute governed rounds (proposal-only by default)',
			},
			parsed.json,
		);
	}
	const loaded = loadTasksFile(directory, parsed.tasksFile);
	if ('error' in loaded) {
		return emit({ status: 'error', error: loaded.error }, parsed.json);
	}
	const status = harnessOptStatus(directory);
	if (status.roundCounter >= config.max_rounds) {
		return emit(
			{
				status: 'stopped',
				stopReason: 'round_budget_exhausted',
				roundCounter: status.roundCounter,
				maxRounds: config.max_rounds,
			},
			parsed.json,
		);
	}
	if (status.stopped) {
		return emit(
			{
				status: 'stopped',
				stopReason: status.stopReason,
				error: 'the loop is stopped; resume with harness-opt plan',
			},
			parsed.json,
		);
	}
	// Rounds execute through the production model dispatcher (the same
	// executor substrate skill-opt validation uses); a runtime without one
	// gets a typed refusal instead of a silently vacuous round.
	if (!runtime.dispatcher) {
		return emit(
			{
				status: 'error',
				error:
					'no evaluation dispatcher available in this runtime (cannot run a governed round)',
			},
			parsed.json,
		);
	}
	const executor = buildRoundExecutor(
		runtime.dispatcher,
		runtime.parentSessionId,
	);
	const result = await runHarnessOptRound({
		projectRoot: directory,
		tasks: loaded.tasks,
		split: parsed.split,
		seed: parsed.seed,
		maxTransientRetries: config.max_transient_retries,
		executor,
	});
	return emit({ status: 'ok', ...result }, parsed.json);
}

/** `/swarm harness-opt status` — loop status + latest lineage summary. */
export async function handleHarnessOptStatus(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseHarnessOptArgs(args);
	const status = harnessOptStatus(directory);
	const lineage = listHarnessOptLineage(directory);
	const latest = lineage[lineage.length - 1];
	return emit(
		{
			status: 'ok',
			loop: status,
			rounds: lineage.length,
			latest: latest
				? {
						roundId: latest.roundId,
						decision: latest.decision,
						artifactOutcome: latest.artifactOutcome,
						tokens: {
							input: latest.tokens_input,
							cache: latest.tokens_cache,
							output: latest.tokens_output,
						},
					}
				: null,
		},
		parsed.json,
	);
}

/** `/swarm harness-opt stop` — human-only operator stop. */
export async function handleHarnessOptStop(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseHarnessOptArgs(args);
	const reason =
		parsed.reason ?? 'stopped by operator via /swarm harness-opt stop';
	const result = await stopHarnessOptLoop({
		projectRoot: directory,
		reason,
	});
	return emit({ status: 'ok', ...result }, parsed.json);
}

/** `/swarm harness-opt history` — bounded lineage listing. */
export async function handleHarnessOptHistory(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseHarnessOptArgs(args);
	const lineage = listHarnessOptLineage(directory);
	const bounded = lineage.slice(-20).map((record) => ({
		roundId: record.roundId,
		roundCounter: record.roundCounter,
		split: record.split,
		decision: record.decision,
		artifactOutcome: record.artifactOutcome,
		tokens: {
			input: record.tokens_input,
			cache: record.tokens_cache,
			output: record.tokens_output,
		},
	}));
	return emit(
		{ status: 'ok', total: lineage.length, rounds: bounded },
		parsed.json,
	);
}
