import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPluginConfigWithMeta } from '../config';
import type { Plan } from '../config/plan-schema';
import { appendCoreEventSync } from '../events/core-events.js';
import { resolveGitExecutable } from '../utils/git-executable';
import { derivePlanIdentityHash } from './utils';

/**
 * Runtime consumer for `checkpoint.auto_checkpoint_threshold` (issue #2582).
 *
 * The schema key has been accepted and validated since v6.4 with a description
 * promising "Number of completed tasks that trigger an automatic checkpoint",
 * but #1691's retention split removed its only (misused) reader and the
 * completed-task trigger was never built — the setting was inert. This module
 * is that trigger: on every completed-task transition routed through
 * `updateTaskStatus`, it counts the authoritative plan's completed tasks and,
 * when the count reaches a multiple of the configured threshold, records one
 * automatic checkpoint via the non-destructive `saveCheckpointRecord` seam.
 *
 * Deliberately loaded only through a lazy dynamic import from
 * `src/plan/manager.ts` (the speckit-checkoff precedent): a static edge would
 * pull the config loader + lock machinery into every plan/manager test graph.
 */

export const DEFAULT_AUTO_CHECKPOINT_THRESHOLD = 3;

const GIT_PROBE_TIMEOUT_MS = 10_000;
const GIT_PROBE_MAX_BUFFER_BYTES = 1024 * 1024;

/** Outcome of evaluating the cadence for one completed transition. */
export interface AutoCheckpointDecision {
	shouldSave: boolean;
	completedCount: number;
	threshold: number;
	label?: string;
	skipReason?:
		| 'disabled'
		| 'below_threshold'
		| 'no_restorable_head'
		| 'already_current';
}

/** Outcome of the full trigger for one completed transition. */
export interface AutoCheckpointOutcome extends AutoCheckpointDecision {
	saved: boolean;
	warning?: string;
}

/**
 * Test seam (AGENTS.md invariant 7): lets tests fault-inject the config
 * loader and the git spawn without mocking the module graph. Restores are
 * the test's responsibility (afterEach).
 */
export const _internals: {
	loadPluginConfigWithMeta: typeof loadPluginConfigWithMeta;
	spawnSync: typeof child_process.spawnSync;
} = {
	loadPluginConfigWithMeta,
	spawnSync: child_process.spawnSync.bind(child_process),
};

export function countCompletedTasks(plan: Plan): number {
	return plan.phases.reduce(
		(total, phase) =>
			total + phase.tasks.filter((task) => task.status === 'completed').length,
		0,
	);
}

/**
 * Deterministic base label for an automatic checkpoint. The 12-hex
 * plan-identity segment distinguishes plans with different swarm/title pairs;
 * a replacement plan with the SAME identity restarts the completed count, so
 * the base label alone cannot distinguish generations — the save path appends
 * `-gN` against the live checkpoint log for that case. Charset and length
 * stay inside `validateLabel`'s allowlist.
 */
export function buildAutoCheckpointLabel(
	plan: Pick<Plan, 'swarm' | 'title'>,
	completedCount: number,
	generation = 1,
): string {
	const identity = derivePlanIdentityHash(plan).slice(0, 12);
	const base = `auto-task-checkpoint-${identity}-${String(completedCount).padStart(3, '0')}`;
	return generation <= 1 ? base : `${base}-g${generation}`;
}

export function evaluateAutoCheckpoint(input: {
	plan: Pick<Plan, 'swarm' | 'title'>;
	completedCount: number;
	threshold: number;
	enabled: boolean;
}): AutoCheckpointDecision {
	const { plan, completedCount, enabled } = input;
	// Defensive integer guard: the schema pins 1-20, but recovery-path configs
	// bypass strict validation, and a 0/negative threshold would modulo-divide
	// by zero or fire on every completion.
	const threshold =
		Number.isInteger(input.threshold) && input.threshold >= 1
			? input.threshold
			: DEFAULT_AUTO_CHECKPOINT_THRESHOLD;

	if (enabled === false) {
		return {
			shouldSave: false,
			completedCount,
			threshold,
			skipReason: 'disabled',
		};
	}
	// count 0 satisfies `0 % n === 0`; an empty/never-started plan must not
	// produce a "0 completed tasks" checkpoint.
	if (completedCount <= 0 || completedCount % threshold !== 0) {
		return {
			shouldSave: false,
			completedCount,
			threshold,
			skipReason: 'below_threshold',
		};
	}
	return {
		shouldSave: true,
		completedCount,
		threshold,
		label: buildAutoCheckpointLabel(plan, completedCount),
	};
}

/**
 * Resolve the current commit SHA, or null when the directory is not a git
 * repository OR the repository has no commits yet (unborn HEAD). Both cases
 * mean an automatic checkpoint would have no restore target — an entry with
 * an empty SHA is dead FIFO weight, so the trigger skips instead of recording
 * (manual `checkpoint save` deliberately still records with a warning).
 */
function resolveHead(directory: string): string | null {
	let result: child_process.SpawnSyncReturns<string>;
	try {
		result = _internals.spawnSync(
			resolveGitExecutable(),
			['rev-parse', 'HEAD'],
			{
				cwd: directory,
				encoding: 'utf-8',
				timeout: GIT_PROBE_TIMEOUT_MS,
				maxBuffer: GIT_PROBE_MAX_BUFFER_BYTES,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			},
		);
	} catch {
		return null;
	}
	if (result.error || result.status !== 0) return null;
	const sha = (result.stdout ?? '').trim();
	return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

interface CheckpointLogEntry {
	label?: unknown;
	sha?: unknown;
}

/** Fail-open read of the checkpoint log's entries (best-effort, lock-free). */
function readCheckpointEntries(
	directory: string,
): Array<{ label: string; sha: string }> {
	try {
		const logPath = path.join(directory, '.swarm', 'checkpoints.json');
		if (!fs.existsSync(logPath)) return [];
		const parsed = JSON.parse(fs.readFileSync(logPath, 'utf-8')) as {
			checkpoints?: CheckpointLogEntry[];
		};
		if (!Array.isArray(parsed.checkpoints)) return [];
		return parsed.checkpoints
			.filter(
				(entry): entry is { label: string; sha: string } =>
					typeof entry?.label === 'string' && typeof entry?.sha === 'string',
			)
			.map((entry) => ({ label: entry.label, sha: entry.sha }));
	} catch {
		return [];
	}
}

/**
 * The trigger proper. Non-fatal by contract: a failed or skipped checkpoint
 * must never propagate to the durable task-status write that already resolved.
 * Failed saves are returned as `{ saved: false, warning }` so the funnel can
 * warn the operator; cadence/disabled/no-head skips carry no warning and stay
 * quiet. `saveCheckpointRecord` itself returns failure results instead of
 * throwing; unexpected throws bubble to the funnel's belt-and-suspenders catch.
 */
export async function maybeSaveAutoCheckpoint(
	directory: string,
	plan: Plan,
): Promise<AutoCheckpointOutcome> {
	let enabled = true;
	let threshold = DEFAULT_AUTO_CHECKPOINT_THRESHOLD;
	try {
		const { config } = _internals.loadPluginConfigWithMeta(directory);
		if (config.checkpoint?.enabled === false) {
			enabled = false;
		}
		if (config.checkpoint?.auto_checkpoint_threshold !== undefined) {
			threshold = config.checkpoint.auto_checkpoint_threshold;
		}
	} catch {
		// The loader fails open to schema defaults on malformed config; this
		// catch guards anything beyond that (unreadable paths). Defaults apply.
	}

	const completedCount = countCompletedTasks(plan);
	const decision = evaluateAutoCheckpoint({
		plan,
		completedCount,
		threshold,
		enabled,
	});
	if (!decision.shouldSave || !decision.label) {
		return { ...decision, saved: false };
	}

	const head = resolveHead(directory);
	if (head === null) {
		return {
			...decision,
			shouldSave: false,
			saved: false,
			skipReason: 'no_restorable_head',
		};
	}

	// Resolve the label generation against the live log (read is lock-free and
	// best-effort; saveCheckpointRecord's own lock + duplicate check keeps the
	// write honest if the log moves between here and the save).
	const existing = readCheckpointEntries(directory);
	const baseLabel = decision.label;
	const sameFamily = existing.filter(
		(entry) => parseLabelGeneration(baseLabel, entry.label) !== null,
	);
	// A prior family entry at the current SHA is an idempotent replay
	// (settled-task no-op re-persist): already recorded, stay quiet.
	if (sameFamily.some((entry) => entry.sha === head)) {
		return { ...decision, saved: true, skipReason: 'already_current' };
	}
	// The suffix space is unbounded and `taken` is finite (bounded by
	// max_retention), so this loop always terminates well before generation
	// exceeds the taken-set size plus one — no exhaustion cap is needed.
	const taken = new Set(existing.map((entry) => entry.label));
	let generation = 1;
	let label = baseLabel;
	while (taken.has(label)) {
		generation += 1;
		label = buildAutoCheckpointLabel(plan, completedCount, generation);
	}

	const { saveCheckpointRecord } = await import('../tools/checkpoint.js');
	const result = await saveCheckpointRecord(label, directory);
	if (result.success) {
		emitAutoSavedEvent(directory, {
			label,
			completedCount,
			threshold: decision.threshold,
		});
		return { ...decision, label, saved: true };
	}
	// A concurrent writer may have recorded this boundary between our
	// lock-free read and the save (the loser of that race gets a
	// duplicate-label failure). Re-read and reconcile: if the live family now
	// holds the SHA we resolved (or the tree's current one — a commit may
	// have landed between our probe and the save), this was exactly the
	// checkpoint we wanted — a quiet idempotent no-op, not an operator
	// warning.
	const reconcileHead = resolveHead(directory) ?? head;
	const afterSave = readCheckpointEntries(directory);
	if (
		afterSave.some(
			(entry) =>
				(entry.sha === head || entry.sha === reconcileHead) &&
				parseLabelGeneration(baseLabel, entry.label) !== null,
		)
	) {
		return { ...decision, label, saved: true, skipReason: 'already_current' };
	}
	return {
		...decision,
		label,
		saved: false,
		warning: result.warning ?? result.error,
	};
}

/**
 * Best-effort observability for automatic saves: retention eviction emits
 * `checkpoint_retention_applied`, so successful automatic saves emit
 * `checkpoint_auto_saved` on the same `.swarm/events.jsonl` stream —
 * operators can see trigger firings. Never throws; the checkpoint write
 * already succeeded.
 */
function emitAutoSavedEvent(
	directory: string,
	payload: { label: string; completedCount: number; threshold: number },
): void {
	try {
		appendCoreEventSync(directory, {
			event: 'checkpoint_auto_saved',
			...payload,
			timestamp: new Date().toISOString(),
		});
	} catch {
		// Best-effort event logging only.
	}
}

/**
 * Generation number for a label in this boundary's family: 1 for the exact
 * base label, 2..N for its `-gN` suffixed forms (any numeric generation —
 * the suffix space is unbounded), null for anything else — including a
 * manually-created label that merely starts with the family prefix (e.g.
 * `<base>-garbage`), which must never be mistaken for an automatic entry.
 */
function parseLabelGeneration(baseLabel: string, label: string): number | null {
	if (label === baseLabel) return 1;
	// Guard the slice: an unrelated label that merely shares the length and a
	// `-gN` tail (but not the base prefix) is not family.
	if (!label.startsWith(baseLabel)) return null;
	const match = /^-g(\d{1,6})$/.exec(label.slice(baseLabel.length));
	if (!match) return null;
	const generation = Number(match[1]);
	// Generation 1 is the bare base label itself; '01' normalizes to 1 and is
	// rejected so zero-padded forms can never shadow the base entry.
	return generation >= 2 ? generation : null;
}
