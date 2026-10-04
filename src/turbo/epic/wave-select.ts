/**
 * Epic v2 C2 — choose the NEXT wave of the current phase.
 *
 * `epic_next_wave` issues one wave at a time. This module decides which
 * tasks that wave contains, reusing the Epic wave planner (`planEpicWaves`)
 * for the first concurrent wave of the phase's unresolved tasks. It never
 * writes: the caller freezes the result into the epic record.
 *
 * Inputs and rules:
 *   - batch = the phase's tasks that are not completed / closed / blocked;
 *   - a dependency OUTSIDE the batch is satisfied only when that task is
 *     `completed` in the plan AND (under git) has a current-plan completion
 *     marker (`isCommitted`, the plan-scoped marker query of `plan-key.ts`);
 *     a dependency on a closed or removed task, on a later-phase task, or a
 *     completed task without a marker makes the dependent
 *     `predecessor-missing` (the plan must be fixed — it can never run);
 *   - scopes: the live `declare_scope` binding, else `files_touched` (an
 *     estimate); the chosen members must all have a live binding, otherwise
 *     the result is `declare-scopes` (suggested files = `files_touched`);
 *   - exclusive first: a ready task the planner degraded (global file /
 *     protected path) or serialized runs ALONE;
 *   - otherwise the planner's first wave, minus learned hot-module tasks
 *     (calibration, they run alone once nothing else is ready) and minus
 *     tasks that co-change-conflict with an earlier member when the
 *     co-change signal is enabled (path conflicts are already excluded by
 *     the planner). Deferred tasks come back in a later wave.
 */

import type { Plan } from '../../config/plan-schema.js';
import type { LeanTurboConfig } from '../../config/schema.js';
import type { CoChangeEntry } from '../../tools/co-change-analyzer.js';
import { normalizePath, pathsConflict } from '../lean/conflicts.js';
import type { PlanPhase } from '../lean/partition-common.js';
import {
	type CoChangeThreshold,
	epicPairConflict,
} from './cochange-conflict.js';
import type { EpicCochangePair } from './lifecycle.js';
import { planEpicWaves } from './wave-planner.js';

/** Max co-change pairs frozen into one wave record. */
export const MAX_WAVE_COCHANGE_PAIRS = 256;

type PlanTask = Plan['phases'][number]['tasks'][number];

export interface EpicWaveSelectionInput {
	directory: string;
	plan: Plan;
	phaseId: number;
	/** Live declared scope per task (`[]` = no live binding). */
	liveScopes: Record<string, string[]>;
	maxParallel: number;
	leanConfig: LeanTurboConfig;
	/**
	 * Current-plan completion evidence for a completed out-of-batch task
	 * (git: plan-scoped marker; non-git: always true). May throw — the caller
	 * maps a throw to `git-failed`.
	 */
	isCommitted: (taskId: string) => boolean;
	/** Learned hot modules (calibration); tasks touching them run alone. */
	hotModules: readonly string[];
	/** Co-change signal (null = disabled by config). */
	cochange: { pairs: CoChangeEntry[]; threshold: CoChangeThreshold } | null;
}

export interface EpicPredecessorProblem {
	taskId: string;
	dependency: string;
	why: 'removed' | 'closed' | 'later-phase' | 'not-committed' | 'cycle';
}

export type EpicWaveSelection =
	| {
			kind: 'wave';
			waveKind: 'parallel' | 'exclusive';
			taskIds: string[];
			files: Record<string, string[]>;
			cochangePairs: EpicCochangePair[];
	  }
	| {
			kind: 'declare-scopes';
			tasks: { taskId: string; suggestedFiles: string[] }[];
	  }
	| { kind: 'task-blocked'; taskIds: string[] }
	| { kind: 'predecessor-missing'; problems: EpicPredecessorProblem[] }
	| { kind: 'none' };

function isResolved(status: string | undefined): boolean {
	return status === 'completed' || status === 'closed';
}

/** The plan-scoped task index: id → task + owning phase id. */
function indexPlan(
	plan: Plan,
): Map<string, { task: PlanTask; phaseId: number }> {
	const index = new Map<string, { task: PlanTask; phaseId: number }>();
	for (const phase of plan.phases) {
		for (const task of phase.tasks ?? []) {
			if (!index.has(task.id)) index.set(task.id, { task, phaseId: phase.id });
		}
	}
	return index;
}

function touchesAny(
	files: readonly string[],
	targets: readonly string[],
): boolean {
	return files.some((file) =>
		targets.some((target) =>
			pathsConflict(normalizePath(file), normalizePath(target)),
		),
	);
}

function pathMatches(scopePath: string, cochangePath: string): boolean {
	return scopePath === cochangePath || scopePath.endsWith(`/${cochangePath}`);
}

/** Threshold-passing pairs whose both files lie within `files`. */
export function cochangePairsWithin(
	files: readonly string[],
	cochange: { pairs: CoChangeEntry[]; threshold: CoChangeThreshold },
): EpicCochangePair[] {
	const normalized = files.map(normalizePath);
	const within = (file: string) => normalized.some((f) => pathMatches(f, file));
	return cochange.pairs
		.filter(
			(pair) =>
				pair.coChangeCount >= cochange.threshold.minCoChanges &&
				pair.npmi >= cochange.threshold.npmi &&
				within(pair.fileA) &&
				within(pair.fileB),
		)
		.sort((a, b) => b.npmi - a.npmi || a.fileA.localeCompare(b.fileA))
		.slice(0, MAX_WAVE_COCHANGE_PAIRS)
		.map((pair) => ({
			fileA: pair.fileA,
			fileB: pair.fileB,
			npmi: pair.npmi,
			coChangeCount: pair.coChangeCount,
		}));
}

/** Choose the next wave of `phaseId` (see the module header). */
export function selectNextEpicWave(
	input: EpicWaveSelectionInput,
): EpicWaveSelection {
	const phase = input.plan.phases.find((p) => p.id === input.phaseId);
	if (!phase) return { kind: 'none' };
	const index = indexPlan(input.plan);
	const tasks = phase.tasks ?? [];
	const blocked = tasks.filter((t) => t.status === 'blocked').map((t) => t.id);
	const batch = tasks.filter(
		(t) => !isResolved(t.status) && t.status !== 'blocked',
	);
	if (batch.length === 0) {
		return blocked.length > 0
			? { kind: 'task-blocked', taskIds: blocked }
			: { kind: 'none' };
	}
	const batchIds = new Set(batch.map((t) => t.id));

	// Out-of-batch dependency satisfaction (evidence read lazily, once).
	const satisfiedOutside = (dep: string): boolean => {
		const found = index.get(dep);
		return found?.task.status === 'completed' && input.isCommitted(dep);
	};

	const problems: EpicPredecessorProblem[] = [];
	for (const task of batch) {
		for (const dep of task.depends ?? []) {
			if (batchIds.has(dep)) continue;
			const found = index.get(dep);
			if (!found) {
				problems.push({ taskId: task.id, dependency: dep, why: 'removed' });
			} else if (found.task.status === 'closed') {
				problems.push({ taskId: task.id, dependency: dep, why: 'closed' });
			} else if (found.task.status === 'completed') {
				if (!input.isCommitted(dep)) {
					problems.push({
						taskId: task.id,
						dependency: dep,
						why: 'not-committed',
					});
				}
			} else if (found.phaseId !== input.phaseId) {
				// Phases are iterations: an earlier phase is complete by the time
				// this phase runs, so an unresolved cross-phase dep is a later one.
				problems.push({ taskId: task.id, dependency: dep, why: 'later-phase' });
			}
		}
	}
	if (problems.length > 0) return { kind: 'predecessor-missing', problems };

	const estimated: Record<string, string[]> = Object.create(null);
	for (const task of batch) {
		const live = input.liveScopes[task.id] ?? [];
		estimated[task.id] = live.length > 0 ? live : (task.files_touched ?? []);
	}
	const view: { phases: PlanPhase[] } = {
		phases: [{ ...phase, tasks: batch } as unknown as PlanPhase],
	};
	const planned = planEpicWaves(
		input.directory,
		input.phaseId,
		view,
		{ ...input.leanConfig, max_parallel_coders: input.maxParallel },
		estimated,
		satisfiedOutside,
	);

	const isReady = (taskId: string): boolean => {
		const task = batch.find((t) => t.id === taskId);
		if (!task) return false;
		return (task.depends ?? []).every(
			(dep) => !batchIds.has(dep) && satisfiedOutside(dep),
		);
	};
	const exclusiveCandidates = [
		...planned.degradedTasks
			.filter(
				(d) =>
					d.reason === 'global file conflict' || d.reason === 'protected path',
			)
			.map((d) => d.taskId),
		...planned.serializedTasks,
	]
		.filter(isReady)
		.sort((a, b) => a.localeCompare(b));

	let chosen: string[] = [];
	let waveKind: 'parallel' | 'exclusive' = 'parallel';
	if (exclusiveCandidates.length > 0) {
		chosen = [exclusiveCandidates[0]];
		waveKind = 'exclusive';
	} else if (planned.waves.length > 0) {
		const first = planned.waves[0].taskIds;
		const hot = first.filter((id) =>
			touchesAny(estimated[id] ?? [], input.hotModules),
		);
		if (hot.length > 0 && (first.length === 1 || hot.length === first.length)) {
			chosen = [hot[0]];
			waveKind = 'exclusive';
		} else {
			const cold = first.filter((id) => !hot.includes(id));
			for (const id of cold) {
				if (
					input.cochange &&
					chosen.some(
						(other) =>
							epicPairConflict(
								estimated[id] ?? [],
								estimated[other] ?? [],
								input.cochange?.pairs ?? [],
								input.cochange?.threshold ?? { npmi: 1, minCoChanges: 1 },
							).conflict,
					)
				) {
					continue;
				}
				chosen.push(id);
			}
		}
	}

	if (chosen.length === 0) {
		if (blocked.length > 0) return { kind: 'task-blocked', taskIds: blocked };
		// Nothing runnable and nothing blocked: a dependency cycle (or a
		// planner leftover) — the plan must be fixed.
		return {
			kind: 'predecessor-missing',
			problems: batch
				.map((task) => ({
					taskId: task.id,
					dependency: (task.depends ?? [])
						.filter((d) => batchIds.has(d))
						.join(', '),
					why: 'cycle' as const,
				}))
				.filter((problem) => problem.dependency.length > 0),
		};
	}

	const undeclared = chosen.filter(
		(id) => (input.liveScopes[id] ?? []).length === 0,
	);
	if (undeclared.length > 0) {
		return {
			kind: 'declare-scopes',
			tasks: undeclared.map((taskId) => ({
				taskId,
				suggestedFiles: [...(index.get(taskId)?.task.files_touched ?? [])],
			})),
		};
	}

	const files: Record<string, string[]> = Object.create(null);
	for (const id of chosen) files[id] = [...(input.liveScopes[id] ?? [])];
	return {
		kind: 'wave',
		waveKind,
		taskIds: chosen,
		files,
		cochangePairs: input.cochange
			? cochangePairsWithin(Object.values(files).flat(), input.cochange)
			: [],
	};
}
