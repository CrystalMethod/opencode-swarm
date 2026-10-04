/**
 * Plan-epoch filter over the shared worktree merge-back status registry
 * (Epic v2 C0).
 *
 * `.swarm/worktree-merge-status.json` is keyed by bare task id and is never
 * cleaned automatically (it also serves `/swarm lanes` and orphan recovery,
 * so it is NOT re-keyed here). Epic Rule 2 consults it to skip the completion
 * marker when a task's work never landed. Without an epoch filter, a failure
 * recorded for task `1.1` of a PREVIOUS plan suppresses Rule 2 for the
 * current plan's `1.1` forever.
 *
 * Most writers stamp `completedAt` and/or `queuedAt`, but NOT all: the
 * delegation-gate `task-result` failure (a cancelled/denied task) records no
 * timestamp. A failure recorded before the current plan's root timestamp
 * belongs to an earlier plan and is ignored. A failure with NO timestamp
 * cannot be dated, so it is treated as relevant (fail closed), surfaced by
 * `/swarm epic status`, and can be cleared explicitly with
 * `/swarm epic clear-merge-failure <taskId> --confirm` (which calls the
 * registry's own `clearWorktreeMergeStatus`, the same function a clean
 * re-dispatch merge-back uses).
 */

import * as path from 'node:path';
import {
	clearWorktreeMergeStatus as clearWorktreeMergeStatus_import,
	getWorktreeMergeFailure as getWorktreeMergeFailure_import,
	initDurableStatusPath as initDurableStatusPath_import,
	_internals as mergeStatusInternals,
	scanWorktreeMergeFailuresForRecovery as scanWorktreeMergeFailuresForRecovery_import,
	type WorktreeMergeFailure,
} from '../../hooks/delegation-gate/worktree-merge-status.js';

/** How a recorded merge failure relates to the current plan. */
export type MergeFailureRelevance = 'current' | 'undated' | 'stale';

/** Classify one failure against the plan root time (`sinceMs`). */
export function classifyMergeFailure(
	failure: WorktreeMergeFailure,
	sinceMs: number,
): MergeFailureRelevance {
	const at = failure.completedAt ?? failure.queuedAt;
	if (typeof at !== 'number' || !Number.isFinite(at)) return 'undated';
	return at >= sinceMs ? 'current' : 'stale';
}

/**
 * The recorded merge-back failure for `taskId` iff it is relevant to the
 * plan that started at `sinceMs`: recorded at/after `sinceMs`
 * (`completedAt ?? queuedAt`), or undated (fail closed). Pass `sinceMs = 0`
 * when the plan root is unknown — every failure is then relevant.
 */
export function relevantMergeFailure(
	taskId: string,
	sinceMs: number,
): WorktreeMergeFailure | undefined {
	const failure = _internals.getWorktreeMergeFailure(taskId);
	if (!failure) return undefined;
	return classifyMergeFailure(failure, sinceMs) === 'stale'
		? undefined
		: failure;
}

/**
 * The durable status file the shared, process-global registry is bound to,
 * or null when it is unbound. Read-only: the binding is never changed here.
 */
function boundStatusPath(): string | null {
	try {
		return _internals.getBoundStatusPath();
	} catch {
		return null;
	}
}

/**
 * {@link relevantMergeFailure} for one project, used by `epic_next_wave`
 * (wave advance rule). The shared registry is process-global and keyed by
 * bare task id, so its in-memory map is trusted only while it is bound to
 * THIS project's durable file (then every record/clear is persisted to that
 * file synchronously). Bound to another project, or unbound, the in-memory
 * map may hold another project's `1.1`: only this project's durable file is
 * read (read-only scan). An unreadable durable file adds nothing; `/swarm
 * epic status` reports it.
 */
export function relevantMergeFailureForProject(
	directory: string,
	taskId: string,
	sinceMs: number,
): WorktreeMergeFailure | undefined {
	const bound = boundStatusPath();
	const ours = path.join(directory, '.swarm', 'worktree-merge-status.json');
	if (bound !== null && path.resolve(bound) === path.resolve(ours)) {
		const live = relevantMergeFailure(taskId, sinceMs);
		if (live) return live;
	}
	const scan = _internals.scanWorktreeMergeFailuresForRecovery(directory);
	if (scan.status !== 'ok') return undefined;
	const durable = scan.failures.find(([id]) => id === taskId)?.[1];
	if (!durable) return undefined;
	return classifyMergeFailure(durable, sinceMs) === 'stale'
		? undefined
		: durable;
}

/**
 * `/swarm epic status` lines for recorded merge failures (read-only scan of
 * the durable file). Empty when there are none. `sinceMs` null ⇒ plan root
 * unknown, every failure is reported as blocking.
 */
export function describeMergeFailuresForStatus(
	directory: string,
	sinceMs: number | null,
): string[] {
	const scan = _internals.scanWorktreeMergeFailuresForRecovery(directory);
	if (scan.status === 'uncertain') {
		return [
			'',
			'### Worktree merge failures',
			`- Could not read \`.swarm/worktree-merge-status.json\`: ${scan.reason}. Rule 2 falls back to the in-memory registry; repair or remove the file (no swarm session running) if this persists.`,
		];
	}
	if (scan.failures.length === 0) return [];
	const lines = ['', '### Worktree merge failures'];
	const rootLabel =
		sinceMs === null
			? 'unknown (no plan ledger)'
			: new Date(sinceMs).toISOString();
	lines.push(`Current plan root: ${rootLabel}`);
	let blocking = 0;
	for (const [taskId, failure] of scan.failures) {
		// Unknown root: nothing is stale, but undated records stay labeled.
		const relevance = classifyMergeFailure(
			failure,
			sinceMs ?? Number.NEGATIVE_INFINITY,
		);
		const what = `${failure.outcome} at '${failure.stage}'`;
		if (relevance === 'stale') {
			lines.push(
				`- ${taskId}: ${what} — stale (recorded before the current plan); ignored by Rule 2.`,
			);
			continue;
		}
		blocking += 1;
		if (relevance === 'undated') {
			lines.push(
				`- ${taskId}: ${what} — NO timestamp, so it cannot be dated against the current plan; treated as BLOCKING (fail closed): Rule 2 will not write task ${taskId}'s completion marker.`,
			);
		} else {
			lines.push(
				`- ${taskId}: ${what} — BLOCKING: Rule 2 will not write task ${taskId}'s completion marker.`,
			);
		}
	}
	if (blocking > 0) {
		lines.push(
			'Remedy: resolve the preserved worktree (`/swarm lanes`) and re-dispatch the task — a clean merge-back clears its record. If the work already landed, or an undated record belongs to an earlier plan, clear it with `/swarm epic clear-merge-failure <taskId> --confirm`.',
		);
	}
	return lines;
}

/**
 * `/swarm epic clear-merge-failure <taskId> [--confirm]` — Epic-owned escape
 * hatch for a merge failure that blocks Rule 2 but no longer reflects
 * reality (work landed by hand, undated record from an earlier plan).
 *
 * Only a task id that currently HAS a recorded failure (durable file or
 * in-memory registry) can be cleared. Without `--confirm` the call is
 * read-only and prints what would be cleared. With it, the registry's own
 * `clearWorktreeMergeStatus` removes the record (in memory + durable file),
 * after `initDurableStatusPath(directory)` binds the registry to this
 * project (a no-op when the delegation gate already did).
 */
export function clearMergeFailureCommand(
	directory: string,
	args: string[],
): string {
	const taskId = args.find((a) => !a.startsWith('--'))?.trim();
	const confirm = args.includes('--confirm');
	if (!taskId) {
		return 'Usage: /swarm epic clear-merge-failure <taskId> [--confirm]';
	}
	const scan = _internals.scanWorktreeMergeFailuresForRecovery(directory);
	const onDisk =
		scan.status === 'ok'
			? scan.failures.find(([id]) => id === taskId)?.[1]
			: undefined;
	const failure = onDisk ?? _internals.getWorktreeMergeFailure(taskId);
	if (!failure) {
		return `No worktree merge failure is recorded for task ${taskId}; nothing to clear.`;
	}
	const at = failure.completedAt ?? failure.queuedAt;
	const detail = `${failure.outcome} at '${failure.stage}' (${typeof at === 'number' && Number.isFinite(at) ? `recorded ${new Date(at).toISOString()}` : 'no timestamp'}): ${failure.message}${failure.worktreePath ? ` — preserved worktree ${failure.worktreePath}` : ''}`;
	if (!confirm) {
		return [
			`Task ${taskId} has a recorded worktree merge failure: ${detail}.`,
			`Clearing it lets Epic Rule 2 write task ${taskId}'s completion marker, so Rule 3 will treat the task as committed. Clear it only if the task's work is in the main tree (or the record belongs to an earlier plan); otherwise resolve the preserved worktree first (\`/swarm lanes\`).`,
			`To clear, run: /swarm epic clear-merge-failure ${taskId} --confirm`,
		].join('\n');
	}
	_internals.initDurableStatusPath(directory);
	_internals.clearWorktreeMergeStatus(taskId);
	return `Cleared the recorded worktree merge failure for task ${taskId} (${detail}). The next \`update_task_status(${taskId}, completed)\` under Epic may write its completion marker.`;
}

/**
 * DI seam (AGENTS.md invariant 7). The shared registry module is consumed
 * through its exported API only, never modified.
 */
export const _internals = {
	clearWorktreeMergeStatus: clearWorktreeMergeStatus_import,
	initDurableStatusPath: initDurableStatusPath_import,
	getWorktreeMergeFailure: getWorktreeMergeFailure_import,
	scanWorktreeMergeFailuresForRecovery:
		scanWorktreeMergeFailuresForRecovery_import,
	/** Throws when the shared registry is unbound (no project path given). */
	getBoundStatusPath: (): string => mergeStatusInternals.getDurableStatusPath(),
};
