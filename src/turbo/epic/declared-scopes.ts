/**
 * Epic Mode declared-scope resolution (v2 binding store only).
 *
 * `declare_scope` persists ONLY v2 scope bindings in the authoritative
 * coordination store; nothing in production writes the legacy v1
 * `.swarm/scopes/scope-<taskId>.json` projection any more. Every Epic
 * scheduling consumer (`epic_decide_phase`, `epic_plan_waves`,
 * `/swarm epic decide`, `/swarm coupling`) therefore resolves declared scopes
 * here, using the same upstream readers `src/plan/parallel-verdict.ts` uses:
 *
 *   - ONE `readAuthoritativeScopeBindingSet` scan per call (#2532 hoisting),
 *   - `readDeclaredScopeFilesFromBindings` per task, pinned to the exact plan
 *     identity (`planId` + `planStructureHash`), live + unexpired only.
 *
 * The result maps EVERY requested task id to a file list — `[]` when the task
 * has no live, agreeing, non-empty binding (undeclared, expired, declared
 * against an older plan revision, store unreadable/overloaded, or no plan).
 * Passing that map as the explicit `scopes` argument of the shared partition
 * preflight (`runPartitionPreflight`) guarantees the preflight never falls
 * back to its own v1 file read for an Epic task: upstream treats an explicit
 * `[]` entry as "effectively undeclared", which then takes exactly the
 * `files_touched` fallback that `require_declared_scope` permits — the same
 * semantics the preflight applies to an undeclared task.
 *
 * Also hosts the calibration-only HISTORICAL declaration read used by
 * `epic_record_divergence` (see {@link readLatestEpicDeclaredScopeForCalibration}).
 *
 * Nothing here is write authority: these are scheduling / calibration reads.
 */

import { type Plan, PlanSchema } from '../../config/plan-schema.js';
import { derivePlanId } from '../../plan/utils.js';
import type { ScopeBinding } from '../../scope/scope-binding.js';
import {
	readAuthoritativeScopeBindingSet,
	readDeclaredScopeFilesFromBindings,
} from '../../scope/scope-persistence.js';

/**
 * Validate an already-parsed plan object (e.g. the raw `plan.json` view an
 * Epic tool loaded) into a full {@link Plan} so its identity (`planId` +
 * `planStructureHash`) can pin binding reads. Returns `null` when the object
 * is not a valid plan; callers then fail closed to "no live declared scope".
 */
export function toEpicPlanIdentity(raw: unknown): Plan | null {
	if (raw === null || raw === undefined) return null;
	const parsed = PlanSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

/**
 * Resolve the live declared scope of each task from the v2 binding store.
 *
 * @param directory - Project root (binding-store location).
 * @param plan - The plan the scopes must be pinned to. `null` (unreadable /
 *        invalid plan) resolves every task to `[]` without touching the store.
 * @param taskIds - Tasks to resolve. Every id appears in the result.
 * @returns `taskId -> files` (`[]` = no live declared scope).
 */
export function resolveEpicDeclaredScopes(
	directory: string,
	plan: Plan | null,
	taskIds: readonly string[],
): Record<string, string[]> {
	const result: Record<string, string[]> = Object.create(null);
	for (const taskId of taskIds) result[taskId] = [];
	if (plan === null || taskIds.length === 0) return result;

	// ONE binding-set scan for the whole call, shared by every task. A null
	// set (store unreadable / overloaded) makes every lookup return null.
	let bindingSet: ScopeBinding[] | null;
	try {
		bindingSet = readAuthoritativeScopeBindingSet(directory);
	} catch {
		bindingSet = null;
	}
	if (bindingSet === null) return result;

	for (const taskId of taskIds) {
		let files: string[] | null = null;
		try {
			files = readDeclaredScopeFilesFromBindings({
				directory,
				taskId,
				plan,
				bindingSet,
			});
		} catch {
			files = null;
		}
		result[taskId] = files && files.length > 0 ? [...files] : [];
	}
	return result;
}

/**
 * Merge Epic's resolved declared scopes with a caller-supplied explicit
 * `scopes` map. The caller's entries win per task id.
 */
export function mergeEpicScopes(
	resolved: Record<string, string[]>,
	callerScopes: Record<string, string[]> | undefined,
): Record<string, string[]> {
	const merged: Record<string, string[]> = Object.create(null);
	for (const [taskId, files] of Object.entries(resolved)) {
		merged[taskId] = files;
	}
	if (callerScopes) {
		for (const [taskId, files] of Object.entries(callerScopes)) {
			merged[taskId] = files;
		}
	}
	return merged;
}

/**
 * HISTORICAL declared-scope read for Epic calibration / divergence reporting
 * ONLY (Capability D). Returns the files of the most recent `declare_scope`
 * declaration binding (`activation === 'declaration'`, no dispatch call) for
 * `(taskId, planId)` regardless of lifecycle state, expiry, or
 * `planStructureHash`.
 *
 * Why it ignores liveness and structure hash: divergence is recorded AFTER a
 * task completes. Completing a phase's last task advances `current_phase`
 * (changing the plan structure hash), and bindings expire after 1 h — so the
 * live scheduling reader legitimately returns nothing exactly when
 * calibration needs the declared baseline. `readAuthoritativeScopeBindingSet`
 * returns every stored binding (live, expired, tombstoned), which is what
 * this historical question needs.
 *
 * NOT write authority and NOT a scheduling input. Returns `null` when no
 * declaration exists, the store is unreadable or over its live-binding
 * capacity (fail closed: calibration skips the observation), or the latest
 * declaration has an empty file list.
 */
export function readLatestEpicDeclaredScopeForCalibration(input: {
	directory: string;
	taskId: string;
	plan: Pick<Plan, 'swarm' | 'title'>;
}): string[] | null {
	if (typeof input.taskId !== 'string' || input.taskId.trim() === '') {
		return null;
	}
	let set: ScopeBinding[] | null;
	try {
		set = readAuthoritativeScopeBindingSet(input.directory);
	} catch {
		set = null;
	}
	if (set === null) return null;
	const planId = derivePlanId(input.plan);
	let latest: ScopeBinding | null = null;
	for (const binding of set) {
		if (
			binding.taskId !== input.taskId ||
			binding.planId !== planId ||
			binding.activation !== 'declaration' ||
			binding.dispatchCallId !== undefined
		) {
			continue;
		}
		if (
			latest === null ||
			binding.declaredAt > latest.declaredAt ||
			(binding.declaredAt === latest.declaredAt &&
				binding.updatedAt > latest.updatedAt)
		) {
			latest = binding;
		}
	}
	if (latest === null) return null;
	return Array.isArray(latest.files) && latest.files.length > 0
		? [...latest.files]
		: null;
}
