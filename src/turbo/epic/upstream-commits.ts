/**
 * Upstream-commit predicate — Rule 3 of the greenfield-smart redesign.
 *
 * Given a project directory, returns a fast `(taskId) => boolean` predicate
 * that answers "has this task been committed?" The lane planner consults
 * this when evaluating cross-batch dependencies: a downstream task is
 * parallel-eligible only when every `depends:` upstream that lives in a
 * prior phase batch is already in git HEAD's history.
 *
 * Why this matters: without it, the planner treats any dep not in the
 * current task batch as implicitly satisfied (the existing behavior in
 * `src/turbo/lean/planner.ts:381-390`). That's fine when the prior batch
 * actually finished cleanly, but it doesn't distinguish "marked complete"
 * from "marked complete *and* the work is in version control". Rule 3
 * insists on the stronger condition so parallel coders can't inherit an
 * uncommitted upstream worktree.
 *
 * Source format: `commitTaskCompletion` writes `swarm(task <id>): <desc>`
 * subjects with a `Swarm-Plan: <planKey>` trailer (see
 * `./task-commit.ts:formatTaskCommitMessage` and `./plan-key.ts`). Only
 * markers belonging to the current plan count.
 *
 * Boundedness (AGENTS.md #3): subprocess timeout matches the rest of git
 * helpers (30s); the marker `--grep` and `--max-count` cap the log scan (the
 * plan-root check is per record in JS, never `--since`);
 * any read failure is reported via `gitFailed` so callers fail closed.
 */

import type { Plan } from '../../config/plan-schema.js';
import { criticalWarn } from '../../utils/logger.js';
import {
	type PlanMarkerScope,
	readPlanScopedCommittedTaskIds,
	resolvePlanMarkerScope,
} from './plan-key.js';

/** Cap on the git-log scan window. */
const MAX_LOG_COMMITS = 10_000;

export interface BuildUpstreamCommitsOptions {
	/** Override the log scan window. Default: 10,000. */
	maxCommits?: number;
}

/**
 * Phase 12 (B10) — the Rule 3 predicate plus whether its evidence read
 * failed. Callers FAIL CLOSED on `gitFailed` (the activation gate swaps in
 * `() => false`; `epic_plan_waves` refuses with `git-failed`).
 *
 * Single evidence source: a `swarm(task <id>):` marker commit produced by
 * Rule 2's `commitTaskCompletion` FOR THE CURRENT PLAN (Epic v2 C0 —
 * `Swarm-Plan:` trailer equal to the plan's key, or a legacy trailer-less
 * marker committed at/after the plan root; see `./plan-key.ts`). A previous
 * plan's marker for a reused task id is NOT evidence.
 *
 * History note: an earlier revision OR'd in a plan-ledger fallback (any
 * completed task counted as committed); Phase 6 removed it because it
 * defeated Rule 3's purpose (distinguishing "marked complete" from "in git
 * history"). The permissive (`() => true` on failure) variant was removed in
 * C0: it had no production caller and could not be plan-scoped.
 */
export interface UpstreamCommittedEvidence {
	predicate: (taskId: string) => boolean;
	/**
	 * True when the evidence could not be read — no plan, plan-identity
	 * resolution failed, or `git log` threw. `predicate` is then permissive
	 * and MUST NOT be used.
	 */
	gitFailed: boolean;
	/** Why the evidence read failed (set iff `gitFailed`). */
	failureReason?: string;
}

function evidenceFailure(reason: string): UpstreamCommittedEvidence {
	// Phase 15 (B34): criticalWarn so the operator sees the degraded
	// predecessor-evidence path during a live run.
	criticalWarn(
		`[epic:upstream-commits] plan-scoped marker read failed (callers fail closed): ${reason}`,
	);
	return { predicate: () => true, gitFailed: true, failureReason: reason };
}

/**
 * Resolve the current plan's marker scope and read every honored marker in
 * one bounded `git log -z` call (marker `--grep`, `--max-count`); each record
 * is checked against the plan key and plan root in JS.
 */
export async function buildIsUpstreamCommittedWithStatus(
	directory: string,
	plan: Plan | null,
	options?: BuildUpstreamCommitsOptions,
): Promise<UpstreamCommittedEvidence> {
	if (!plan) {
		return evidenceFailure('no valid plan to scope markers to');
	}
	let scope: PlanMarkerScope;
	try {
		scope = await _internals.resolvePlanMarkerScope(directory, plan);
	} catch (err) {
		return evidenceFailure(
			`plan identity unavailable: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	let committed: Set<string>;
	try {
		committed = _internals.readCommittedTaskIds(
			directory,
			scope,
			options?.maxCommits ?? MAX_LOG_COMMITS,
		);
	} catch (err) {
		return evidenceFailure(
			`git log scan failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return {
		predicate: (taskId: string) => committed.has(taskId),
		gitFailed: false,
	};
}

/**
 * DI seam — production code routes the scope resolution and the git-log
 * read through `_internals` so tests substitute deterministic doubles
 * without `mock.module` (AGENTS.md invariant 7).
 */
export const _internals = {
	resolvePlanMarkerScope,
	readCommittedTaskIds: readPlanScopedCommittedTaskIds,
};
