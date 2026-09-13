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
import {
	type ComparativeArmResult,
	type ComparativeExecutor,
	type ComparativeTaskDescriptor,
	runComparativeProtocol,
} from '../services/harness-optimizer/comparative.js';
import {
	evaluatePilotGraduation,
	freezeHarnessOptTaskSet,
	harnessOptStatus,
	runHarnessOptRound,
	stopHarnessOptLoop,
} from '../services/harness-optimizer/controller.js';
import { listHarnessOptLineage } from '../services/harness-optimizer/lineage.js';
import { validateComparativeManifest } from '../services/harness-optimizer/manifest.js';
import { evaluateIndependentOracle } from '../services/harness-optimizer/oracle.js';

interface ParsedHarnessOptArgs {
	json: boolean;
	confirm: boolean;
	tasksFile: string | undefined;
	manifestFile: string | undefined;
	lowerCi: number | undefined;
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
	const lowerCiArg = flagValue('--lower-ci');
	const lowerCi =
		lowerCiArg !== undefined && Number.isFinite(Number(lowerCiArg))
			? Number(lowerCiArg)
			: undefined;
	return {
		json,
		confirm,
		tasksFile: flagValue('--tasks'),
		manifestFile: flagValue('--manifest'),
		lowerCi,
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
				stopReason: 'stopped_by_operator',
				operatorReason: status.stopReason,
				note: 'the loop is stopped; clear the stop with harness-opt plan before running',
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
		maxWallClockMs: config.max_wall_clock_ms,
		maxSpendUsd: config.max_spend_usd,
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

/** `/swarm harness-opt compare` — the separately executable comparative
 * evaluation work package (issue #2503): three arms on one frozen task
 * population, an independently validated manifest when supplied, the
 * independent oracle's verdict on baseline-vs-candidate summaries, and a
 * pilot-graduation record retaining the observed evidence verbatim.
 * Human-gated: requires --confirm and an evaluation dispatcher; never
 * consumes a held-out split and never mutates the harness. */
export async function handleHarnessOptCompare(
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
					'pass --confirm to execute the comparative evaluation (three arms run the full task population)',
			},
			parsed.json,
		);
	}
	const loaded = loadTasksFile(directory, parsed.tasksFile);
	if ('error' in loaded) {
		return emit({ status: 'error', error: loaded.error }, parsed.json);
	}
	let manifestResult:
		| { ok: true }
		| { ok: false; code: string; reason: string } = { ok: true };
	if (parsed.manifestFile) {
		const manifestPath = path.resolve(directory, parsed.manifestFile);
		if (!manifestPath.startsWith(path.resolve(directory))) {
			return emit(
				{
					status: 'error',
					error: '--manifest path must stay inside the project root',
				},
				parsed.json,
			);
		}
		try {
			const rawManifest = JSON.parse(
				readFileSync(manifestPath, 'utf8'),
			) as unknown;
			const validated = validateComparativeManifest(rawManifest);
			if (!validated.ok) {
				return emit(
					{
						status: 'error',
						error: `comparative manifest rejected (${validated.code}): ${validated.reason}`,
					},
					parsed.json,
				);
			}
			manifestResult = { ok: true };
		} catch {
			return emit(
				{
					status: 'error',
					error: `manifest file is not valid JSON: ${parsed.manifestFile}`,
				},
				parsed.json,
			);
		}
	}
	if (!runtime.dispatcher) {
		return emit(
			{
				status: 'error',
				error:
					'no evaluation dispatcher available in this runtime (cannot run the comparative arms)',
			},
			parsed.json,
		);
	}
	const executor = buildRoundExecutor(
		runtime.dispatcher,
		runtime.parentSessionId,
	);
	const harnessOptBlock = (runtime.config ?? undefined) as
		| { run_ablation_arm?: boolean; run_simple_agent_arm?: boolean }
		| undefined;
	const comparative = await runComparativeProtocol({
		projectRoot: directory,
		tasks: loaded.tasks,
		seed: parsed.seed,
		executor,
		runAblationArm: harnessOptBlock?.run_ablation_arm,
		runSimpleAgentArm: harnessOptBlock?.run_simple_agent_arm,
	});
	const arms: ComparativeArmResult[] = Object.values(comparative.arms);
	// Independent oracle over the observed arm summaries: the baseline arm
	// versus the strongest non-baseline arm's verified completions.
	const verifiedOf = (arm: ComparativeArmResult) => arm.completed;
	const baseline = comparative.arms.baseline;
	const bestCandidate = [
		comparative.arms.ablation,
		comparative.arms['simple-agent'],
	].reduce(
		(best, arm) => (verifiedOf(arm) > verifiedOf(best) ? arm : best),
		comparative.arms.ablation,
	);
	const oracle = await evaluateIndependentOracle({
		baseline: {
			n: baseline.n,
			acceptedArtifacts: verifiedOf(baseline),
			verificationEvidence: verifiedOf(baseline),
			tokens: { input: 'unknown', cache: 'unknown', output: 'unknown' },
		},
		candidate: {
			n: bestCandidate.n,
			acceptedArtifacts: verifiedOf(bestCandidate),
			verificationEvidence: verifiedOf(bestCandidate),
			tokens: { input: 'unknown', cache: 'unknown', output: 'unknown' },
		},
	});
	// Pilot graduation records the OBSERVED evidence verbatim; without a
	// measured CI the conservative negative result is retained (never an
	// unmeasured improvement claim).
	const improvementLowerCi = parsed.lowerCi ?? 0;
	const pilot = await evaluatePilotGraduation({
		projectRoot: directory,
		criteria: { lowerCiThreshold: 0 },
		evidence: {
			improvementLowerCi,
			protectedRegressions: arms
				.filter((arm) => arm.failed > 0)
				.map((arm) => `${arm.arm}-arm ${arm.failed} failed tasks`),
		},
	});
	return emit(
		{
			status: 'ok',
			manifest: manifestResult.ok ? 'validated' : 'rejected',
			taskPopulationHash: comparative.taskPopulationHash,
			arms: Object.fromEntries(
				arms.map((arm) => [
					arm.arm,
					{
						n: arm.n,
						completed: arm.completed,
						failed: arm.failed,
						transientFailures: arm.transientFailures,
					},
				]),
			),
			oracle,
			pilot,
		},
		parsed.json,
	);
}
