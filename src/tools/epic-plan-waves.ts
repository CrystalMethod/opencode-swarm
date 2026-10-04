/**
 * Epic Mode `epic_plan_waves` tool.
 *
 * Wraps `planEpicWaves` from `src/turbo/epic/wave-planner`. Partitions a
 * phase's pending tasks into ordered concurrent waves and returns them in a
 * shape the architect can iterate over for wave-by-wave Task dispatch.
 *
 * This is Epic Mode's replacement for `lean_turbo_plan_lanes`. The lane
 * planner stays in place for non-Epic Lean Turbo callers; Epic flows route
 * through this tool because the wave abstraction expresses branching DAGs
 * (sibling fanout from a shared prefix) correctly, where lanes collapse them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPluginConfigWithMeta as loadPluginConfigWithMeta_import } from '../config';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../config/constants';
import type { LeanTurboConfig } from '../config/schema';
import { isGitRepo as isGitRepo_import } from '../git/branch';
import { loadPlanJsonOnly as loadPlanJsonOnly_import } from '../plan/manager';
import {
	EPIC_MODE_CONFIG_DISABLED_MESSAGE,
	isEpicModeConfigEnabled,
} from '../turbo/epic/config-gate';
import {
	mergeEpicScopes,
	resolveEpicDeclaredScopes as resolveEpicDeclaredScopes_import,
	toEpicPlanIdentity,
} from '../turbo/epic/declared-scopes';
import { checkEpicBranch as checkEpicBranch_import } from '../turbo/epic/epic-branch';
import {
	type EpicRecordV1,
	getOpenEpic as getOpenEpic_import,
} from '../turbo/epic/lifecycle';
import { buildIsUpstreamCommittedWithStatus as buildIsUpstreamCommittedWithStatus_import } from '../turbo/epic/upstream-commits';
import { type EpicWavePlan, planEpicWaves } from '../turbo/epic/wave-planner';
import type { PlanPhase } from '../turbo/lean/partition-common';
import { criticalWarn } from '../utils/logger.js';
import { createSwarmTool } from './create-tool';

/** Arguments for the `epic_plan_waves` tool. */
export interface EpicPlanWavesArgs {
	directory: string;
	phase: number;
	scopes?: Record<string, string[]>;
}

/** Result envelope. */
export interface EpicPlanWavesResult {
	success: boolean;
	/** Set on success — the full wave plan from `planEpicWaves`. */
	plan?: EpicWavePlan;
	/** Set on success — shortcut alias for `plan.waves`. */
	waves?: EpicWavePlan['waves'];
	/** Set on success — shortcut alias for `plan.serializedTasks`. */
	serializedTasks?: EpicWavePlan['serializedTasks'];
	/** Set on success — shortcut alias for `plan.degradedTasks`. */
	degradedTasks?: EpicWavePlan['degradedTasks'];
	/**
	 * Set when `reason === 'scopes-missing'` — the task ids that have no
	 * live declared scope (undeclared, expired, or declared against an older
	 * plan revision) and no `files_touched` fallback. The architect must
	 * re-run `declare_scope` for each of these (or pass them in the explicit
	 * `scopes` map) and re-invoke this tool.
	 */
	missingScopes?: string[];
	/** Set on failure — categorical short code (machine-readable). */
	reason?:
		| 'epic-disabled-by-config'
		| 'epic-mode-not-active'
		| 'epic-state-unreadable'
		| 'epic-branch-mismatch'
		| 'no-plan'
		| 'no-phase'
		| 'phase-empty'
		| 'phase-already-complete'
		| 'scopes-missing'
		| 'git-failed'
		| 'planner-error';
	/** Set on failure — long-form actionable error text. */
	errors?: string[];
}

function readPlanJson(directory: string): { phases: PlanPhase[] } | null {
	const planPath = path.join(directory, '.swarm', 'plan.json');
	if (!fs.existsSync(planPath)) return null;
	try {
		return JSON.parse(fs.readFileSync(planPath, 'utf-8'));
	} catch {
		return null;
	}
}

/**
 * Execute the `epic_plan_waves` tool.
 *
 * Possible outcomes:
 *   0. `epic-disabled-by-config` — `turbo.epic.mode.enabled !== true`
 *      `epic-mode-not-active` — no epic open for the current plan
 *      `epic-state-unreadable` — the Epic lifecycle row is unreadable
 *      `epic-branch-mismatch` — HEAD is not the epic's branch (EPIC_BRANCH_MISMATCH)
 *   1. `no-plan` — `.swarm/plan.json` missing / unparseable
 *   2. `no-phase` — phase number not in `plan.json`
 *   3. `phase-empty` — phase exists but has zero tasks
 *   4. `phase-already-complete` — every task already completed
 *   5. `scopes-missing` — one or more pending tasks have no declared scope
 *      (preflight; identical to `epic_decide_phase` so the architect can't
 *      bypass scope discipline by calling planner direct)
 *   6. `git-failed` — git log scan failed (Rule 3 evidence unavailable;
 *      we fail closed rather than implicitly satisfying cross-batch deps)
 *   7. success — `plan` and aliased fields populated
 */
export async function executeEpicPlanWaves(
	args: EpicPlanWavesArgs,
): Promise<EpicPlanWavesResult> {
	const { directory, phase, scopes } = args;

	// Config master gate (`turbo.epic.mode.enabled`, default false). Loaded
	// once and reused for the `turbo.lean.*` knobs below. A config load
	// failure fails CLOSED for the gate (Epic Mode is opt-in).
	let loadedConfig: Awaited<
		ReturnType<typeof _internals.loadPluginConfigWithMeta>
	> | null = null;
	try {
		loadedConfig = await _internals.loadPluginConfigWithMeta(directory);
	} catch {
		loadedConfig = null;
	}
	if (!isEpicModeConfigEnabled(loadedConfig?.config)) {
		return {
			success: false,
			reason: 'epic-disabled-by-config',
			errors: [EPIC_MODE_CONFIG_DISABLED_MESSAGE],
		};
	}

	// An epic must be open for the current plan (`/swarm epic start`). Its
	// record carries the wave-width cap (1 for non-git projects, M-i).
	let epic: EpicRecordV1 | null;
	try {
		epic = _internals.getOpenEpic(directory);
	} catch (error) {
		return {
			success: false,
			reason: 'epic-state-unreadable',
			errors: [
				`${error instanceof Error ? error.message : String(error)}. Ask the user to run \`/swarm epic status\` (diagnose) or \`/swarm epic close --abandon\` (repair).`,
			],
		};
	}
	if (!epic) {
		return {
			success: false,
			reason: 'epic-mode-not-active',
			errors: [
				'No epic is open for the current plan. Ask the user to run `/swarm epic start`; until then execute the phase per-task serially.',
			],
		};
	}
	// Branch-drift guard (Epic v2 C1b, M-e): waves are planned against HEAD
	// (Rule 3 markers), which must still be the epic branch.
	const branch = _internals.checkEpicBranch(directory, epic);
	if (!branch.ok) {
		return {
			success: false,
			reason: 'epic-branch-mismatch',
			errors: [branch.message],
		};
	}

	const plan = _internals.readPlanJson(directory);
	if (!plan) {
		return {
			success: false,
			reason: 'no-plan',
			errors: [
				'plan.json not found or unparseable in .swarm directory. ' +
					'Run `/swarm specify` to bootstrap a plan, then retry.',
			],
		};
	}

	// Shape-validate the plan envelope BEFORE accessing array methods on it.
	// A hand-edited or partially-restored plan.json can have `phases` set to
	// a non-array (string, object, null) or a phase's `tasks` set similarly.
	// Without this guard the next `.find` / `.length` / `.filter` throws a
	// raw TypeError that bubbles past the wider `try` below as an opaque
	// promise rejection.
	if (!Array.isArray(plan.phases)) {
		return {
			success: false,
			reason: 'no-plan',
			errors: [
				'plan.json `phases` is not an array. ' +
					'The plan file may be corrupt or hand-edited; restore from a known-good version or re-run `/swarm specify`.',
			],
		};
	}

	const phaseObj = plan.phases.find((p) => p.id === phase);
	if (!phaseObj) {
		const availablePhases = plan.phases.map((p) => p.id).join(', ');
		return {
			success: false,
			reason: 'no-phase',
			errors: [
				`Phase ${phase} not found in plan.json. ` +
					`Available phases: ${availablePhases || '(none)'}. ` +
					'Re-invoke `epic_plan_waves` with a valid phase number.',
			],
		};
	}

	// Defensive: phase exists but its `tasks` field is missing / null / not
	// an array. Treat as `phase-empty` (semantically equivalent) rather than
	// crashing on `.length` / `.filter`.
	const tasksArray: typeof phaseObj.tasks = Array.isArray(phaseObj.tasks)
		? phaseObj.tasks
		: [];

	if (tasksArray.length === 0) {
		return {
			success: false,
			reason: 'phase-empty',
			errors: [
				`Phase ${phase} exists in plan.json but has zero tasks defined. ` +
					'Either populate this phase with tasks (declared scopes, depends, acceptance) ' +
					'and re-invoke, or remove the empty phase from plan.json and advance.',
			],
		};
	}

	const pendingTasks = tasksArray.filter((t) => t.status !== 'completed');
	if (pendingTasks.length === 0) {
		return {
			success: false,
			reason: 'phase-already-complete',
			errors: [
				`Phase ${phase} has no pending tasks — every task is already completed. ` +
					'Advance to the next phase, or set tasks back to "pending" if you intend to re-run.',
			],
		};
	}

	// Everything below this point hits disk or git and can throw on bad
	// filesystem state, scope-corruption, or git-process crashes. We wrap
	// it all so any unexpected throw surfaces as `planner-error` instead
	// of bubbling out of the tool as an opaque promise rejection.
	try {
		// ONE plan-identity + v2 binding-set read for the whole call, shared
		// by the preflight below and the wave planner (#2532 hoisting).
		// `declare_scope` persists only v2 bindings; the legacy v1
		// `.swarm/scopes/scope-<taskId>.json` projection is never consulted:
		// every phase task gets an explicit entry (`[]` = no live declared
		// scope), so the shared partition preflight never falls back to its
		// v1 file read. Caller-supplied `scopes` entries win per task.
		const declaredScopes = _internals.resolveEpicDeclaredScopes(
			directory,
			toEpicPlanIdentity(plan),
			pendingTasks.map((task) => task.id),
		);
		const effectiveScopes = mergeEpicScopes(declaredScopes, scopes);

		// Preflight: every pending task must have either a live declared
		// scope binding OR `files_touched` populated OR an explicit
		// scopes-map entry. Without scope data the wave planner has nothing
		// to partition on and would silently emit zero waves. Same gate as
		// `epic_decide_phase` for consistency.
		const tasksMissingScope: string[] = [];
		for (const task of pendingTasks) {
			const declaredScope = declaredScopes[task.id] ?? [];
			const filesTouched = task.files_touched ?? [];
			const providedScope =
				scopes && task.id in scopes ? scopes[task.id] : null;
			if (
				declaredScope.length === 0 &&
				filesTouched.length === 0 &&
				(providedScope === null || providedScope.length === 0)
			) {
				tasksMissingScope.push(task.id);
			}
		}
		if (tasksMissingScope.length > 0) {
			const list = tasksMissingScope.join(', ');
			return {
				success: false,
				reason: 'scopes-missing',
				missingScopes: tasksMissingScope,
				errors: [
					`Cannot plan waves for phase ${phase}: ${tasksMissingScope.length} pending task(s) ` +
						`have no live declared scope and no files_touched in plan.json. ` +
						`A declared scope is missing when it was undeclared, expired (bindings live 1h), ` +
						`or the plan was revised since declaration. ` +
						`The wave planner needs scope data to compute disjoint concurrent groups; ` +
						`without it the dispatch is silently serial and Epic Mode's parallelization is lost.\n\n` +
						`Missing scopes: ${list}\n\n` +
						`Resolution: re-run \`declare_scope\` once for EACH of those task ids with the exact ` +
						`file paths the task will touch (or pass them in the explicit \`scopes\` map argument). ` +
						`Then re-invoke \`epic_plan_waves(phase=${phase})\`.`,
				],
			};
		}

		// Rule 3 of greenfield-smart: cross-batch deps must be in git history.
		// Mirror the lane planner's status-bearing predicate so we fail
		// closed when git is unhealthy (a permissive fallback here would
		// let the wave planner fan out cross-batch deps without evidence,
		// bypassing Phase 10's safety on the very next call).
		let isUpstreamCommitted: ((taskId: string) => boolean) | undefined;
		if (_internals.isGitRepo(directory)) {
			// Markers are plan-scoped (Epic v2 C0): the validated plan supplies
			// the identity/epoch whose `Swarm-Plan:` trailer counts as evidence.
			const evidence = await _internals.buildIsUpstreamCommittedWithStatus(
				directory,
				await _internals.loadPlanJsonOnly(directory),
			);
			if (evidence.gitFailed) {
				criticalWarn(
					`[epic_plan_waves] wave-planning blocked for directory=${directory} phase=${phase}: ${evidence.failureReason ?? 'git log scan failed'}. Any prior promote verdict in .swarm/evidence/epic-promotions.jsonl for this phase is not backed by actual parallel execution.`,
				);
				return {
					success: false,
					reason: 'git-failed',
					errors: [
						`epic_plan_waves: cannot verify cross-batch upstream-commit evidence — plan-scoped \`git log\` marker read failed (${evidence.failureReason ?? 'unknown'}). ` +
							'Likely transient: retry once git is healthy (e.g. another process released its lock). ' +
							'If git is persistently broken (corrupt repo, permission issue, missing `.git`), repair the repository. ' +
							'Until repaired, complete the phase serially — one task at a time, waiting for each commit to land before dispatching the next — so file-scope conflict detection is not required.',
					],
				};
			}
			isUpstreamCommitted = evidence.predicate;
		}

		// Honor user-set `turbo.lean.*` config knobs (max_parallel_coders,
		// require_declared_scope, conflict_policy, degrade_on_risk) by
		// loading the project's plugin config and merging over the
		// defaults. Falls back to defaults on any load failure so a
		// malformed user config doesn't break planning.
		let leanConfig: LeanTurboConfig = { ...DEFAULT_LEAN_TURBO_CONFIG };
		const userLean = loadedConfig?.config?.turbo?.lean;
		if (userLean) {
			leanConfig = { ...leanConfig, ...userLean };
		}
		// The open epic's wave-width cap wins (non-git epics run serially).
		leanConfig = {
			...leanConfig,
			max_parallel_coders: Math.min(
				leanConfig.max_parallel_coders,
				epic.config.maxParallel,
			),
		};

		const wavePlan = planEpicWaves(
			directory,
			phase,
			plan,
			leanConfig,
			effectiveScopes,
			isUpstreamCommitted,
		);

		return {
			success: true,
			plan: wavePlan,
			waves: wavePlan.waves,
			serializedTasks: wavePlan.serializedTasks,
			degradedTasks: wavePlan.degradedTasks,
		};
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		criticalWarn(
			`[epic_plan_waves] wave-planning failed for directory=${directory} phase=${phase}: ${errMsg}. Any prior promote verdict in .swarm/evidence/epic-promotions.jsonl for this phase is not backed by actual parallel execution.`,
		);
		return {
			success: false,
			reason: 'planner-error',
			errors: [errMsg],
		};
	}
}

/**
 * DI seam — same pattern as `lean-turbo-plan-lanes.ts` (AGENTS.md invariant 7).
 * Tests substitute deterministic doubles via `_internals.*` rather than `mock.module`.
 */
export const _internals = {
	readPlanJson,
	resolveEpicDeclaredScopes: resolveEpicDeclaredScopes_import,
	isGitRepo: (cwd: string): boolean => isGitRepo_import(cwd),
	// Only the status-bearing, plan-scoped variant exists (the permissive
	// `buildIsUpstreamCommitted` was removed in Epic v2 C0); callers must
	// fail closed on `gitFailed`.
	buildIsUpstreamCommittedWithStatus: buildIsUpstreamCommittedWithStatus_import,
	loadPlanJsonOnly: loadPlanJsonOnly_import,
	loadPluginConfigWithMeta: loadPluginConfigWithMeta_import,
	getOpenEpic: getOpenEpic_import,
	checkEpicBranch: checkEpicBranch_import,
};

/** Tool definition for `epic_plan_waves`. */
export const epic_plan_waves: ToolDefinition = createSwarmTool({
	description:
		"Partition a phase's pending tasks into ordered concurrent waves for Epic Mode dispatch. " +
		'A wave is a set of tasks with mutually disjoint declared scopes and all dependencies satisfied by prior waves. ' +
		'Returns `{ waves: [{ waveId, taskIds, files }, ...], serializedTasks, degradedTasks }`. ' +
		'For each wave in order, the architect dispatches one `Task(subagent_type="coder", ...)` per `taskId` — all in one assistant message — so the wave runs concurrently and each coder appears as a visible subagent. ' +
		'Wait for the wave to finish before dispatching the next. ' +
		'Pair with `epic_decide_phase` (called first; this tool is only relevant on a `promote` verdict). ' +
		'Preflight reject reasons: `epic-disabled-by-config` (set `turbo.epic.mode.enabled: true`), `epic-mode-not-active` (no epic open — `/swarm epic start`), `epic-state-unreadable`, `no-plan`, `no-phase`, `phase-empty`, `phase-already-complete`, `scopes-missing` (declared scope undeclared, expired after 1h, or declared against an older plan revision — re-run `declare_scope` for each of `missingScopes`, or pass them in `scopes`), `git-failed` (transient — retry), `planner-error`.',
	args: {
		directory: z
			.string()
			.describe('Project root directory where `.swarm/plan.json` is located'),
		phase: z.number().int().positive().describe('Phase number to plan'),
		scopes: z
			.record(z.string(), z.array(z.string()))
			.optional()
			.describe(
				'Optional explicit scopes map (taskId -> file paths). Tasks absent from the map resolve from their live `declare_scope` binding for the current plan revision, then from `files_touched` in plan.json.',
			),
	},
	execute: async (args: unknown, _directory: string) => {
		const parsed = args as EpicPlanWavesArgs;
		const result = await executeEpicPlanWaves({
			...parsed,
			directory: _directory,
		});
		return JSON.stringify(result, null, 2);
	},
});
