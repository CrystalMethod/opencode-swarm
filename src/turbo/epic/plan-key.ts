/**
 * Plan-scoped Epic completion markers (Epic v2 C0).
 *
 * Rule 2 writes a `swarm(task <id>):` marker commit when a task completes;
 * Rule 2's idempotency guard and Rule 3's predecessor evidence read those
 * markers back. Task ids repeat across plans (every plan has a `1.1`), so a
 * marker must be bound to the plan that wrote it — otherwise a previous
 * plan's `swarm(task 1.1):` makes the current plan's 1.1 an idempotent skip
 * (its work is never committed) and satisfies Rule 3 falsely.
 *
 * Binding:
 *   - Every marker carries a `Swarm-Plan: <planKey>` trailer, where
 *     `planKey = sha256(planIdentityHash + '|' + (planEpoch ?? '')).slice(0, 16)`.
 *     The plan epoch is minted per ledger root, so two consecutive plans with
 *     the same title still get different keys.
 *   - A marker WITH a trailer is honored only when the trailer equals the
 *     current planKey AND it was committed at/after the plan root (the
 *     earliest plan-ledger event); a legacy marker WITHOUT a trailer is
 *     honored only when committed at/after the plan root. The root check is
 *     done in JS on each record's committer time — NOT with `git log
 *     --since`, whose walk stops at the first commit older than the cutoff
 *     and would hide newer markers beneath an old-dated commit (clock skew,
 *     `rebase --committer-date-is-author-date`). Reads are bounded by the
 *     `--grep` filter plus `--max-count`.
 *   - Records are NUL-separated (`git log -z`); git refuses NUL bytes in
 *     commit messages, so a message body cannot forge a record boundary.
 *   - When the plan root is unknown (no ledger), legacy markers are never
 *     honored and the scan is bounded only by its max-count (fail closed).
 *
 * Subprocess discipline: every git call goes through `src/git/branch.ts`
 * `gitExec` (array-form, explicit cwd, timeout, bounded buffer, stdin
 * ignored — AGENTS.md #3).
 */

import { createHash } from 'node:crypto';
import type { Plan } from '../../config/plan-schema.js';
import { _internals as gitBranchInternals } from '../../git/branch.js';
import {
	readLedgerEvents as readLedgerEvents_import,
	readPlanEpochIdentity as readPlanEpochIdentity_import,
} from '../../plan/ledger.js';
import { derivePlanIdentityHash } from '../../plan/utils.js';
import { canonicalRootKey } from '../../utils/canonical-root.js';
import { withTimeout } from '../../utils/timeout.js';

/** The commit-message trailer key binding a marker to its plan. */
export const SWARM_PLAN_TRAILER_KEY = 'Swarm-Plan';

/** Identity of the plan whose markers may be honored. */
export interface PlanMarkerScope {
	/** 16-hex-char key written into the `Swarm-Plan:` trailer. */
	planKey: string;
	/**
	 * Earliest plan-ledger event time (ms since epoch), or null when the
	 * ledger is absent / carries no parseable timestamp.
	 */
	rootTimestampMs: number | null;
}

/** One `swarm(task <id>):` marker commit read back from git. */
export interface ParsedTaskMarker {
	taskId: string;
	/** Last `Swarm-Plan:` trailer value; null for a legacy (pre-C0) marker. */
	planKey: string | null;
	/** Committer time in seconds since epoch (`%ct`). */
	committedAtSec: number;
}

/** Subject shape produced by `formatTaskCommitMessage`. */
export const SWARM_TASK_SUBJECT_RE = /^swarm\(task ([^)]+)\):/;
const TRAILER_LINE_RE = /^Swarm-Plan:[ \t]*(\S+)[ \t]*$/;
const RECORD_SEP = '\0';
const FIELD_SEP = '\x1f';
/**
 * `git log -z --format` producing `<ct> US <raw message>` per commit, records
 * separated by NUL (`-z`).
 */
const MARKER_LOG_FORMAT = '--format=%ct%x1f%B';

/** Bound on scope resolution (ledger reads) so Rule 2/3 never hang. */
export const PLAN_SCOPE_RESOLVE_TIMEOUT_MS = 10_000;
/** Max (directory, planKey) entries in the root-timestamp cache (FIFO). */
export const MAX_ROOT_TS_CACHE_ENTRIES = 16;

/**
 * Defensive taskId scrubber for commit-subject and grep-pattern use (Phase
 * 17 C.H2). Plan-ledger dep ids flow here from LLM-authored plans without
 * re-validation; a `)` or newline would corrupt the subject regex. Keeps
 * only characters safe in both a git subject and an ERE literal.
 */
export function scrubTaskIdForGitSubject(taskId: string): string {
	return taskId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function escapeForEre(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `sha256(planIdentityHash + '|' + (planEpoch ?? '')).slice(0, 16)`. */
export function computePlanKey(
	planIdentityHash: string,
	planEpoch: string | null,
): string {
	return createHash('sha256')
		.update(`${planIdentityHash}|${planEpoch ?? ''}`, 'utf8')
		.digest('hex')
		.slice(0, 16);
}

/** The trailer line appended to every Rule 2 marker commit message. */
export function formatSwarmPlanTrailer(planKey: string): string {
	return `${SWARM_PLAN_TRAILER_KEY}: ${planKey}`;
}

/** Root timestamp floored to whole seconds (git commit-time granularity). */
function rootSeconds(scope: PlanMarkerScope): number | null {
	return scope.rootTimestampMs === null
		? null
		: Math.floor(scope.rootTimestampMs / 1000);
}

const rootTimestampCache = new Map<string, number>();

function cacheRootTimestamp(key: string, value: number): void {
	if (rootTimestampCache.has(key)) rootTimestampCache.delete(key);
	rootTimestampCache.set(key, value);
	while (rootTimestampCache.size > MAX_ROOT_TS_CACHE_ENTRIES) {
		const oldest = rootTimestampCache.keys().next().value;
		if (oldest === undefined) break;
		rootTimestampCache.delete(oldest);
	}
}

async function resolveRootTimestampMs(
	directory: string,
	planKey: string,
	cacheable: boolean,
): Promise<number | null> {
	const cacheKey = `${canonicalRootKey(directory)}\0${planKey}`;
	if (cacheable) {
		const cached = rootTimestampCache.get(cacheKey);
		if (cached !== undefined) return cached;
	}
	const events = await _internals.readLedgerEvents(directory);
	let earliest: number | null = null;
	for (const event of events) {
		const ms = Date.parse(event.timestamp);
		if (Number.isFinite(ms) && (earliest === null || ms < earliest)) {
			earliest = ms;
		}
	}
	// Only epoch-bearing plans are cached: an epoch is minted per ledger
	// root, so (directory, planKey) can never map to a different root. A
	// null-epoch (legacy) key is shared by every same-title plan and is
	// therefore re-read each time.
	if (cacheable && earliest !== null) cacheRootTimestamp(cacheKey, earliest);
	return earliest;
}

async function resolvePlanMarkerScopeUnbounded(
	directory: string,
	plan: Plan,
): Promise<PlanMarkerScope> {
	const identity = await _internals.readPlanEpochIdentity(directory, plan);
	const planKey = computePlanKey(
		identity?.planIdentityHash ?? derivePlanIdentityHash(plan),
		identity?.planEpoch ?? null,
	);
	const rootTimestampMs = await resolveRootTimestampMs(
		directory,
		planKey,
		identity !== null,
	);
	return { planKey, rootTimestampMs };
}

/**
 * Resolve the marker scope (planKey + plan root time) for `plan`. Throws
 * when the ledger identity is invalid/conflicting or the read exceeds
 * {@link PLAN_SCOPE_RESOLVE_TIMEOUT_MS}; callers fail closed on a throw
 * (no marker written, Rule 3 evidence unavailable).
 */
export async function resolvePlanMarkerScope(
	directory: string,
	plan: Plan,
): Promise<PlanMarkerScope> {
	return withTimeout(
		resolvePlanMarkerScopeUnbounded(directory, plan),
		_internals.resolveTimeoutMs,
		new Error(
			`plan marker scope resolution timed out after ${_internals.resolveTimeoutMs}ms`,
		),
	);
}

/**
 * Parse `git log` output produced with {@link MARKER_LOG_FORMAT}. Records
 * whose subject is not a `swarm(task <id>):` marker are dropped (a squash
 * message may quote a marker in its body).
 */
export function parseTaskMarkerLog(output: string): ParsedTaskMarker[] {
	const markers: ParsedTaskMarker[] = [];
	for (const record of output.split(RECORD_SEP)) {
		const sep = record.indexOf(FIELD_SEP);
		if (sep < 0) continue;
		const committedAtSec = Number.parseInt(record.slice(0, sep).trim(), 10);
		if (!Number.isFinite(committedAtSec)) continue;
		const lines = record
			.slice(sep + 1)
			.split('\n')
			.map((line) => line.replace(/\r$/, ''));
		const subject = (lines[0] ?? '').trim();
		const match = SWARM_TASK_SUBJECT_RE.exec(subject);
		if (!match) continue;
		let planKey: string | null = null;
		for (const line of lines.slice(1)) {
			const trailer = TRAILER_LINE_RE.exec(line);
			if (trailer) planKey = trailer[1];
		}
		markers.push({ taskId: match[1], planKey, committedAtSec });
	}
	return markers;
}

/**
 * Whether a parsed marker belongs to the plan in `scope`:
 *  - committed before the plan root ⇒ never (bounds trailer markers too);
 *  - with a trailer ⇒ only when it equals the current planKey;
 *  - legacy (no trailer) ⇒ only when the plan root is known.
 */
export function isMarkerHonored(
	marker: ParsedTaskMarker,
	scope: PlanMarkerScope,
): boolean {
	const since = rootSeconds(scope);
	if (since !== null && marker.committedAtSec < since) return false;
	if (marker.planKey !== null) return marker.planKey === scope.planKey;
	return since !== null;
}

/** Bound on per-task marker records read by the idempotency probe. */
const MAX_TASK_MARKER_RECORDS = 64;

/**
 * `git log` args for one task's markers (the plan-root check happens per
 * record in JS — see the file header for why `--since` is not used). Exported for
 * argv assertions in tests.
 */
export function buildTaskMarkerLogArgs(taskId: string): string[] {
	const escaped = escapeForEre(scrubTaskIdForGitSubject(taskId));
	return [
		'log',
		'-z',
		'--extended-regexp',
		`--grep=^swarm\\(task ${escaped}\\):`,
		`--max-count=${MAX_TASK_MARKER_RECORDS}`,
		MARKER_LOG_FORMAT,
	];
}

/** `git log` args for the bulk Rule 3 read (plan-root check in JS). */
export function buildAllMarkersLogArgs(maxCommits: number): string[] {
	return [
		'log',
		'--no-merges',
		'-z',
		'--extended-regexp',
		'--grep=^swarm\\(task [^)]+\\):',
		`--max-count=${maxCommits}`,
		MARKER_LOG_FORMAT,
	];
}

/**
 * True when a marker for `taskId` that belongs to the current plan exists.
 * Throws on git failure (the caller decides its fail-closed policy).
 */
export function hasPlanScopedTaskMarker(
	cwd: string,
	taskId: string,
	scope: PlanMarkerScope,
): boolean {
	const safeId = scrubTaskIdForGitSubject(taskId);
	const output = gitBranchInternals.gitExec(
		buildTaskMarkerLogArgs(taskId),
		cwd,
	);
	return parseTaskMarkerLog(output).some(
		(marker) => marker.taskId === safeId && isMarkerHonored(marker, scope),
	);
}

/**
 * Task ids with a current-plan marker, from one bounded `git log` read.
 * Throws on git failure.
 */
export function readPlanScopedCommittedTaskIds(
	cwd: string,
	scope: PlanMarkerScope,
	maxCommits: number,
): Set<string> {
	const output = gitBranchInternals.gitExec(
		buildAllMarkersLogArgs(maxCommits),
		cwd,
	);
	const committed = new Set<string>();
	for (const marker of parseTaskMarkerLog(output)) {
		if (isMarkerHonored(marker, scope)) committed.add(marker.taskId);
	}
	return committed;
}

/** Test-only: number of cached root timestamps. */
export function _rootTimestampCacheSizeForTest(): number {
	return rootTimestampCache.size;
}

/** Test-only: clear the root-timestamp cache. */
export function _resetRootTimestampCacheForTest(): void {
	rootTimestampCache.clear();
}

/**
 * DI seam (AGENTS.md invariant 7) — tests substitute ledger readers and the
 * resolution deadline without `mock.module`. Restore in `afterEach`.
 */
export const _internals = {
	readLedgerEvents: readLedgerEvents_import,
	readPlanEpochIdentity: readPlanEpochIdentity_import,
	resolveTimeoutMs: PLAN_SCOPE_RESOLVE_TIMEOUT_MS,
};
