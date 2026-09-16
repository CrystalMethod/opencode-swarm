/**
 * Task-attempt cohort snapshot and qualification (issue #2676 / Workstream D16).
 *
 * A causal-rate claim over task attempts requires a stable cohort: a snapshot
 * of the live population taken at a recorded instant (so later mutation cannot
 * change a reported denominator), captured provenance manifests for the
 * trigger / WAL / event / host-status sources (stats + bounded digests, never
 * content parsing), configuration/version strata, and an uncertainty channel
 * that is present whenever sample size or cost fields are incomplete. Reports
 * that cannot meet the contract stay explicitly unqualified and render as
 * descriptive operational counts (the boundary documented in
 * docs/execution-attempt-tracing.md).
 *
 * The mutable-population rule: `snapshotTaskAttemptCohort` deep-copies the
 * population it is handed; every later mutation of the caller's array (or of
 * a nested field of a captured record) is invisible to the snapshot and to
 * every report built from it.
 *
 * Durability: when `directory` is provided, the snapshot persists ONE frozen
 * manifest JSON under `.swarm/observability/cohorts/` (FIFO-bounded to the
 * latest 20 files; write failures are warn-logged and never propagate). This
 * is the only filesystem side effect, and it is registered in the retention
 * registry (row `observability-cohorts`).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { warn } from '../utils/logger.js';

/** Maximum bytes digested from any single manifest source (bounded read). */
const MANIFEST_DIGEST_LIMIT_BYTES = 64 * 1024;

/** Number of frozen cohort manifests retained on disk (FIFO). */
export const COHORT_MANIFEST_RETENTION = 20;

/** Sample size below which a cohort always reports a sample-size uncertainty. */
export const COHORT_SAMPLE_SIZE_THRESHOLD = 30;

/** The provenance manifest sources captured before a cohort is reported. */
export type CohortManifestSource = 'trigger' | 'wal' | 'event' | 'host_status';

export interface CohortManifestEntry {
	source: CohortManifestSource;
	status: 'captured' | 'unavailable';
	capturedAt: string;
	sizeBytes?: number;
	digest?: string;
}

/** One population record (a folded execution-attempt row or equivalent). */
export interface TaskAttemptPopulationRecord {
	taskId?: string;
	attemptClass?: string;
	outcomeStatus?: string;
	cost?: unknown;
	[key: string]: unknown;
}

export interface TaskAttemptCohortStrata {
	pluginVersion?: string;
	runtime?: string;
	configHash?: string;
}

export interface TaskAttemptCohortSnapshot {
	tasks: readonly TaskAttemptPopulationRecord[];
	capturedAt: string;
	count: number;
	strata: TaskAttemptCohortStrata;
	manifests: readonly CohortManifestEntry[];
}

export interface TaskCohortReport {
	denominator: number;
	capturedAt: string;
	perClassCounts: Record<string, number>;
	/** Sum over records that HELD the axis (unknown axes contribute nothing). */
	costTotalsKnown: Record<string, number>;
	/** Per axis: how many captured records did not hold the value. */
	costUnavailableCounts: Record<string, number>;
	strata: TaskAttemptCohortStrata;
	/** Non-empty whenever sample size or cost fields are incomplete. */
	uncertainty: string[];
	qualification: { qualified: boolean; reasons: string[] };
}

function deepCopyRecord(
	record: TaskAttemptPopulationRecord,
): TaskAttemptPopulationRecord {
	try {
		return structuredClone(record);
	} catch {
		return JSON.parse(JSON.stringify(record)) as TaskAttemptPopulationRecord;
	}
}

function captureFileManifest(
	source: CohortManifestSource,
	filePath: string,
	capturedAt: string,
): CohortManifestEntry {
	try {
		const stats = fs.statSync(filePath);
		if (!stats.isFile()) throw new Error('not a regular file');
		const fd = fs.openSync(filePath, 'r');
		try {
			const buffer = Buffer.alloc(MANIFEST_DIGEST_LIMIT_BYTES);
			const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
			const digest = createHash('sha256')
				.update(buffer.subarray(0, bytesRead))
				.digest('hex');
			return {
				source,
				status: 'captured',
				capturedAt,
				sizeBytes: stats.size,
				digest,
			};
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		// Missing or unreadable source is an explicit fact, never synthesized.
		return { source, status: 'unavailable', capturedAt };
	}
}

/** Minimal shape of `process.versions` this module derives a label from. */
export type RuntimeVersions = { bun?: string; node?: string };

/**
 * Derive the honest runtime label from the host's version table. Bun also
 * defines `process.versions.node`, so the branch must test bun PRESENCE —
 * never string truthiness (a `.trim()`-based `||` fallback yields the bare,
 * version-less "bun" under Node, which sha256-hashes into a poisoned
 * host-status digest).
 */
export function deriveRuntimeLabel(versions: RuntimeVersions): string {
	if (versions.bun !== undefined) {
		return `bun ${versions.bun}`;
	}
	return `node ${versions.node ?? ''}`;
}

function captureHostStatusManifest(
	capturedAt: string,
	strata: TaskAttemptCohortStrata,
): CohortManifestEntry {
	const runtime = strata.runtime ?? deriveRuntimeLabel(process.versions);
	if (runtime === '') {
		return { source: 'host_status', status: 'unavailable', capturedAt };
	}
	const digest = createHash('sha256').update(runtime).digest('hex');
	return {
		source: 'host_status',
		status: 'captured',
		capturedAt,
		digest,
	};
}

function manifestFileName(
	capturedAt: string,
	manifests: readonly CohortManifestEntry[],
): string {
	const combined = manifests
		.map((m) => `${m.source}:${m.status}:${m.digest ?? '-'}`)
		.join('|');
	const suffix = createHash('sha256')
		.update(combined)
		.digest('hex')
		.slice(0, 12);
	const epoch = Date.parse(capturedAt);
	const stamp = Number.isFinite(epoch) ? epoch : 0;
	return `${stamp}-${suffix}.json`;
}

function persistSnapshotManifest(
	directory: string,
	snapshot: TaskAttemptCohortSnapshot,
): void {
	try {
		const cohortDir = path.join(
			directory,
			'.swarm',
			'observability',
			'cohorts',
		);
		fs.mkdirSync(cohortDir, { recursive: true });
		const name = manifestFileName(snapshot.capturedAt, snapshot.manifests);
		const target = path.join(cohortDir, name);
		const body = JSON.stringify(
			{
				capturedAt: snapshot.capturedAt,
				count: snapshot.count,
				strata: snapshot.strata,
				manifests: snapshot.manifests,
				tasks: snapshot.tasks,
			},
			null,
			2,
		);
		fs.writeFileSync(target, `${body}\n`, 'utf-8');
		const files = fs
			.readdirSync(cohortDir)
			.filter((f) => f.endsWith('.json'))
			.sort();
		const excess = files.length - COHORT_MANIFEST_RETENTION;
		for (let i = 0; i < excess; i++) {
			try {
				fs.unlinkSync(path.join(cohortDir, files[i]));
			} catch {
				// A transiently locked file (Windows EBUSY/EPERM) must not abort
				// the trim pass — the next snapshot re-reads and re-trims.
			}
		}
	} catch (error) {
		warn('Task cohort manifest persistence failed (warn-only)', {
			code: error instanceof Error ? error.message.slice(0, 80) : String(error),
		});
	}
}

/**
 * Snapshot the live task-attempt population. The population is DEEP-copied:
 * later mutation of the caller's array or of nested record fields cannot
 * change this snapshot or any report built from it. Provenance manifests for
 * the trigger / WAL / event stores are captured BEFORE the population copy is
 * returned, so the reported cohort metric is bound to the population state
 * the manifests describe. When `directory` is provided the snapshot is
 * persisted as a frozen manifest under `.swarm/observability/cohorts/`.
 */
export function snapshotTaskAttemptCohort(input: {
	tasks: TaskAttemptPopulationRecord[];
	directory?: string;
	strata?: TaskAttemptCohortStrata;
	now?: Date;
}): TaskAttemptCohortSnapshot {
	const capturedAt = (input.now ?? new Date()).toISOString();
	const strata: TaskAttemptCohortStrata = input.strata ?? {};
	// Write the derived runtime back so the serialized manifest body carries
	// the same label the host-status digest was computed over.
	if (strata.runtime === undefined) {
		strata.runtime = deriveRuntimeLabel(process.versions);
	}
	const directory = input.directory;

	const manifests: CohortManifestEntry[] = [
		captureFileManifest(
			'trigger',
			directory !== undefined
				? path.join(directory, '.swarm', 'events.jsonl')
				: '',
			capturedAt,
		),
		captureFileManifest(
			'wal',
			directory !== undefined
				? path.join(directory, '.swarm', 'knowledge-receipts-v2.jsonl')
				: '',
			capturedAt,
		),
		captureFileManifest(
			'event',
			directory !== undefined
				? path.join(directory, '.swarm', 'telemetry.jsonl')
				: '',
			capturedAt,
		),
		captureHostStatusManifest(capturedAt, strata),
	];

	const tasks = input.tasks.map(deepCopyRecord);
	const snapshot: TaskAttemptCohortSnapshot = {
		tasks,
		capturedAt,
		count: tasks.length,
		strata,
		manifests,
	};
	if (directory !== undefined) {
		persistSnapshotManifest(directory, snapshot);
	}
	return snapshot;
}

const REPORT_COST_AXES = [
	'latencyMs',
	'inputTokens',
	'outputTokens',
	'cacheReadTokens',
	'estimatedCostUsd',
	'billedCostUsd',
] as const;

function numericAxis(
	record: TaskAttemptPopulationRecord,
	axis: string,
): number | null {
	const cost = record.cost;
	if (cost === null || typeof cost !== 'object') return null;
	const value = (cost as Record<string, unknown>)[axis];
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		return null;
	}
	return value;
}

/**
 * Build the cohort report from a snapshot. The denominator is the SNAPSHOT's
 * captured count — never a live recount. Uncertainty entries are present
 * whenever the sample is below threshold, any cost axis is unavailable on any
 * record, or any record lacks an outcome; qualification is false with
 * enumerated reasons when the cohort cannot support a causal-rate claim.
 */
export function buildTaskCohortReport(
	snapshot: TaskAttemptCohortSnapshot,
): TaskCohortReport {
	const tasks = snapshot.tasks;
	const denominator = snapshot.count;

	const perClassCounts: Record<string, number> = {};
	const costTotalsKnown: Record<string, number> = {};
	const costUnavailableCounts: Record<string, number> = {};
	for (const axis of REPORT_COST_AXES) {
		costTotalsKnown[axis] = 0;
		costUnavailableCounts[axis] = 0;
	}

	let outcomesMissing = 0;
	for (const task of tasks) {
		const cls =
			typeof task.attemptClass === 'string'
				? task.attemptClass
				: 'unclassified';
		perClassCounts[cls] = (perClassCounts[cls] ?? 0) + 1;
		if (typeof task.outcomeStatus !== 'string' || task.outcomeStatus === '') {
			outcomesMissing++;
		}
		for (const axis of REPORT_COST_AXES) {
			const value = numericAxis(task, axis);
			if (value === null) {
				costUnavailableCounts[axis]++;
			} else {
				costTotalsKnown[axis] += value;
			}
		}
	}

	const uncertainty: string[] = [];
	if (denominator < COHORT_SAMPLE_SIZE_THRESHOLD) {
		uncertainty.push(
			`sample_size_below_threshold:${denominator}<${COHORT_SAMPLE_SIZE_THRESHOLD}`,
		);
	}
	for (const axis of REPORT_COST_AXES) {
		if (costUnavailableCounts[axis] > 0) {
			uncertainty.push(
				`cost_axis_unavailable:${axis}:${costUnavailableCounts[axis]}`,
			);
		}
	}
	if (outcomesMissing > 0) {
		uncertainty.push(`outcome_unknown:${outcomesMissing}`);
	}

	const reasons: string[] = [];
	if (denominator === 0) reasons.push('no_population');
	const strataCount = Object.values(snapshot.strata).filter(
		(v) => typeof v === 'string' && v !== '',
	).length;
	if (strataCount === 0) reasons.push('missing_strata');
	for (const manifest of snapshot.manifests) {
		if (manifest.status !== 'captured') {
			reasons.push(`manifest_unavailable:${manifest.source}`);
		}
	}

	return {
		denominator,
		capturedAt: snapshot.capturedAt,
		perClassCounts,
		costTotalsKnown,
		costUnavailableCounts,
		strata: snapshot.strata,
		uncertainty,
		qualification: {
			qualified: reasons.length === 0,
			reasons,
		},
	};
}

export const _internals = {
	captureFileManifest,
	captureHostStatusManifest,
	deriveRuntimeLabel,
	manifestFileName,
	persistSnapshotManifest,
	deepCopyRecord,
};
