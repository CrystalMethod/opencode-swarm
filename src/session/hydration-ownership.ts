/**
 * Project-owned, generation-fenced hydration state (issue #2667).
 *
 * The live maps on `swarmState` are process-resident and keyed by sessionID;
 * hydration is a per-PROJECT operation. This module owns the per-project
 * registries that scope a hydration's blast radius to the project that
 * initiated it and fence stale generations from publishing over newer state:
 *
 * - `projectHydrationGenerations` — monotonic counter per canonical project
 *   key, bumped ONLY when a hydration is initiated (`beginHydrationScope`).
 *   Session creation NEVER bumps it; new sessions stamp `current + 1` so a
 *   session created while generation `g` is latest survives any later apply
 *   at `g`.
 * - `rehydrationCaches` — the plan/evidence rehydration cache, keyed per
 *   project (replaces the former process-singleton `_rehydrationCache`).
 * - `hydratedAggregateKeys` — the toolAggregates keys each project's last
 *   hydration published, so a re-hydration replaces only its own keys.
 *
 * Fence rule: a hydration whose scope generation `g` satisfies
 * `projectHydrationGenerations[K] > g` is REJECTED before any mutation —
 * some newer hydration began for that project. Stamp rule: an accepted
 * hydration at `g` evicts only sessions owned by `K` with
 * `hydrationStamp <= g`.
 *
 * All maps are bounded (FIFO) with an explicit reset path
 * (`clearHydrationOwnershipState`, called by `resetSwarmState`) per
 * AGENTS.md invariant 8.
 */

import { canonicalProjectKey } from '../db/canonical-project.js';
import { canonicalRootKeyLexical } from '../utils/canonical-root.js';

/** Upper bound for tracked per-project registries (matches MAX_READY_ROOTS). */
export const MAX_TRACKED_PROJECTS = 32;

/** Upper bound for the raw-spelling → canonical-key memo. */
export const MAX_DIRECTORY_KEY_MEMO = 64;

/** Opaque cache payload owned by state.ts; opaque here by design. */
export type ProjectRehydrationCache = unknown;

/** Fence token captured when a hydration is initiated; see beginHydrationScope. */
export interface HydrationScope {
	projectKey: string;
	generation: number;
}

const projectHydrationGenerations = new Map<string, number>();
const rehydrationCaches = new Map<string, ProjectRehydrationCache>();
const hydratedAggregateKeys = new Map<string, Set<string>>();
const directoryKeyMemo = new Map<string, string>();

function evictOldest(map: Map<string, unknown>, cap: number): void {
	while (map.size >= cap) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}

/**
 * Resolve the canonical project key for a directory spelling through a
 * module-owned bounded memo: exactly ONE realpath-equivalent resolution per
 * distinct spelling per process; every later call is a pure Map hit.
 *
 * The memo is keyed by `canonicalRootKeyLexical` (the shared filesystem-free
 * lexical alias key, per the path-identity ratchet — raw resolved paths must
 * not key project maps) so distinct spellings memoize independently while
 * lexically-identical spellings share one entry — whose canonical resolution
 * is identical anyway.
 *
 * `canonicalProjectKey` itself is intentionally NOT memoized (it calls
 * `canonicalRootKeyFresh`, bypassing the shared `canonicalRootMemo`), which
 * is why this memo exists — `beginHydrationScope`/`startAgentSession` sit on
 * the plugin-init and chat.message hot paths. A symlink retargeted
 * mid-process yields a second key: fail-safe isolation (separate ownership
 * buckets), never corruption. `canonicalProjectKey` never throws (lexical
 * `path.resolve` fallback on realpath failure) — that fallback is accepted.
 */
export function hydrationProjectKey(directory: string): string {
	const memoKey = canonicalRootKeyLexical(directory);
	const memoized = directoryKeyMemo.get(memoKey);
	if (memoized !== undefined) return memoized;
	const key = canonicalProjectKey(directory);
	if (!directoryKeyMemo.has(memoKey)) {
		evictOldest(directoryKeyMemo, MAX_DIRECTORY_KEY_MEMO);
	}
	directoryKeyMemo.set(memoKey, key);
	return key;
}

/**
 * Begin a hydration scope: bump the project's generation counter and return
 * the fence token. The token must be captured when the hydration is
 * INITIATED (e.g. at `loadSnapshot` entry) and carried into
 * `rehydrateState`, which refuses to apply it once any newer generation has
 * begun.
 */
export function beginHydrationScope(directory: string): HydrationScope {
	const projectKey = hydrationProjectKey(directory);
	const generation = (projectHydrationGenerations.get(projectKey) ?? 0) + 1;
	// Update-in-place must not evict a DIFFERENT project's entry at the cap:
	// only make room when this project is not already tracked (otherwise a
	// bump for a tracked project would reset an unrelated project's counter).
	if (!projectHydrationGenerations.has(projectKey)) {
		evictOldest(projectHydrationGenerations, MAX_TRACKED_PROJECTS);
	}
	projectHydrationGenerations.set(projectKey, generation);
	return { projectKey, generation };
}

/** Latest initiated hydration generation for a project (0 when never). */
export function currentHydrationGeneration(projectKey: string): number {
	return projectHydrationGenerations.get(projectKey) ?? 0;
}

/**
 * Stamp value for a session created NOW under `projectKey`:
 * `current + 1`, i.e. newer than any already-initiated hydration, so an
 * in-flight or late apply at the current generation can never evict it.
 */
export function nextSessionHydrationStamp(projectKey: string): number {
	return currentHydrationGeneration(projectKey) + 1;
}

export function getRehydrationCache(
	projectKey: string,
): ProjectRehydrationCache | undefined {
	return rehydrationCaches.get(projectKey);
}

export function setRehydrationCache(
	projectKey: string,
	cache: ProjectRehydrationCache,
): void {
	if (!rehydrationCaches.has(projectKey)) {
		evictOldest(rehydrationCaches, MAX_TRACKED_PROJECTS);
	}
	rehydrationCaches.set(projectKey, cache);
}

/** Record the aggregate keys a project's hydration published (replace set). */
export function recordHydratedAggregateKeys(
	projectKey: string,
	keys: Set<string>,
): void {
	if (!hydratedAggregateKeys.has(projectKey)) {
		evictOldest(hydratedAggregateKeys, MAX_TRACKED_PROJECTS);
	}
	hydratedAggregateKeys.set(projectKey, new Set(keys));
}

/** The aggregate keys the project's last hydration published (empty if none). */
export function hydratedAggregateKeysFor(projectKey: string): Set<string> {
	return hydratedAggregateKeys.get(projectKey) ?? new Set<string>();
}

/** Reset every registry (invariant 8: bounded state with an explicit reset). */
export function clearHydrationOwnershipState(): void {
	projectHydrationGenerations.clear();
	rehydrationCaches.clear();
	hydratedAggregateKeys.clear();
	directoryKeyMemo.clear();
}
