/**
 * Divergence recorder for Epic Mode Capability D (self-calibration).
 *
 * When `epic_next_wave` closes a wave (`wave-close.ts`), for every
 * completed task with known actual files this module:
 *   1. Compares the task's DECLARED scope (frozen into the wave record at
 *      issue) against the ACTUAL files attributed to that exact task
 *      (unioned across same-project sessions, or the git fallback for a
 *      single-task wave; nothing is recorded without actual files).
 *   2. Computes divergence — undeclared writes (actual − declared), unused
 *      declarations (declared − actual), and a per-task divergence ratio
 *      (undeclared / max(1, actual)). A declared directory covers descendants.
 *   3. Appends one record to `.swarm/epic/divergence.jsonl`, idempotently.
 *
 * The calibration engine (`./calibration-engine.ts`) is rolled forward over
 * this history right after the wave close records it (hot-module list +
 * threshold override). This module just records.
 *
 * Pure I/O: never throws to the caller. Failures are logged and swallowed
 * so the task-completion path is never blocked by an audit write.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveRetentionCap } from '../../retention/caps.js';
import * as logger from '../../utils/logger.js';
import { normalizePath, pathsConflict } from '../lean/conflicts.js';

/** One record per task completion. */
export interface DivergenceRecord {
	/** ISO 8601. */
	timestamp: string;
	sessionID: string;
	taskId: string;
	/** `derivePlanId` of the task's plan; keys `(planId, taskId)` dedupe. */
	planId?: string; // absent on legacy records — those are never deduplicated
	/** Phase the task belonged to, when known. */
	phaseNumber?: number;
	/** Normalised paths of the task's latest `declare_scope` declaration. */
	declaredScope: string[];
	/** Normalised paths attributed to this task's coder writes. */
	actualFiles: string[];
	/** Files in `actualFiles` not covered by `declaredScope` (dirs cover). */
	undeclared: string[];
	/** Entries in `declaredScope` covering no file in `actualFiles`. */
	unused: string[];
	/** undeclared.length / max(1, actualFiles.length). 0 ⇒ fully declared. */
	divergenceRatio: number;
	/** True when divergenceRatio === 0 (no undeclared writes). */
	isClean: boolean;
}
const EVIDENCE_REL_DIR = path.join('.swarm', 'epic');
const EVIDENCE_FILE = 'divergence.jsonl';

/**
 * Global byte cap on `.swarm/epic/divergence.jsonl` (issue #2483 §2).
 * Byte-cap contract (critic N2): compaction retains the newest WHOLE records
 * that fit within the effective cap, with a floor of at least one record — a
 * non-empty stream is never emptied by compaction (one record ≈ 320 B; under
 * any smaller effective cap the file keeps the newest single record). The
 * effective value resolves through `resolveRetentionCap` so the #2483
 * acceptance checks can shrink the cap below this default and prove the
 * writer clamps.
 */
export const MAX_DIVERGENCE_BYTES = 8 * 1024 * 1024;

/**
 * Write-side compaction enforcing {@link MAX_DIVERGENCE_BYTES}. Applies the
 * same rule as `appendCappedJsonl`'s compaction (src/retention/jsonl-cap.ts)
 * but synchronously: `recordTaskDivergence` is a synchronous best-effort
 * audit writer on the task-completion path and cannot await the async
 * helper. Crash-atomic rewrite (temp + rename); on failure the file stays
 * transiently over cap by at most one record and the next append retries.
 */
function compactToByteCap(filePath: string): void {
	const maxBytes = resolveRetentionCap(
		'MAX_DIVERGENCE_BYTES',
		MAX_DIVERGENCE_BYTES,
	);
	let size: number;
	try {
		size = fs.statSync(filePath).size;
	} catch {
		return;
	}
	if (size <= maxBytes) return;
	let content: string;
	try {
		content = fs.readFileSync(filePath, 'utf-8');
	} catch {
		return; // next append retries compaction
	}
	const lines = content
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const kept: string[] = [];
	let keptBytes = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] as string;
		const lineBytes = Buffer.byteLength(`${line}\n`, 'utf-8');
		// Whole-record floor: the newest record is always kept, even when a
		// single record alone exceeds the effective cap.
		if (kept.length > 0 && keptBytes + lineBytes > maxBytes) break;
		kept.unshift(line);
		keptBytes += lineBytes;
	}
	if (kept.length === 0) return;
	const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	try {
		fs.writeFileSync(tmpPath, `${kept.join('\n')}\n`, 'utf-8');
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			/* best-effort residue cleanup */
		}
		logger.warn(
			`[epic/divergence] byte-cap compaction failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Compute the divergence between a declared scope and the files actually
 * modified. Pure — no I/O, no side effects. Returns the diff sets plus the
 * ratio used by the calibration engine.
 *
 * Path comparison uses `normalizePath` (POSIX-style, no trailing slash,
 * Windows-lowercased) from Lean Turbo's conflicts module so the comparison
 * is consistent with everything else in the lane planner.
 */
export function computeDivergence(
	declaredScope: readonly string[],
	actualFiles: readonly string[],
): {
	declared: string[];
	actual: string[];
	undeclared: string[];
	unused: string[];
	divergenceRatio: number;
} {
	const declared = Array.from(new Set(declaredScope.map(normalizePath))).sort();
	const actual = Array.from(new Set(actualFiles.map(normalizePath))).sort();
	// A declared entry covers an actual file when they are the same path OR
	// the declared entry is a directory prefix of it at a segment boundary —
	// the same containment rule as Lean's `pathsConflict`, made directional
	// (declared ⊇ actual). So writes inside a declared directory scope are
	// declared, and a directory scope with writes inside it is used.
	const covers = (declaredPath: string, actualPath: string): boolean =>
		declaredPath.length <= actualPath.length &&
		pathsConflict(declaredPath, actualPath);
	const undeclared = actual.filter((f) => !declared.some((d) => covers(d, f)));
	const unused = declared.filter((d) => !actual.some((f) => covers(d, f)));
	const divergenceRatio =
		actual.length === 0 ? 0 : undeclared.length / actual.length;
	return { declared, actual, undeclared, unused, divergenceRatio };
}

interface RecordTaskDivergenceArgs {
	directory: string;
	sessionID: string;
	taskId: string;
	/** Plan identity; enables `(planId, taskId)` idempotency (see record). */
	planId?: string;
	phaseNumber?: number;
	declaredScope: readonly string[];
	actualFiles: readonly string[];
}

/**
 * Append one divergence record to the JSONL audit file.
 *
 * Append-only, line-delimited so partial writes are tolerable (the calibration
 * reader skips malformed lines). Best-effort — never throws to caller:
 *   - Directory-creation failure → log and return null.
 *   - Append write failure → log and return null.
 * Either keeps the task-completion path moving even if the audit subsystem
 * is broken (audit miss is not a correctness issue; blocking task completion
 * would be).
 */
export function recordTaskDivergence(
	args: RecordTaskDivergenceArgs,
): { path: string; record: DivergenceRecord; duplicate?: boolean } | null {
	const {
		directory,
		sessionID,
		taskId,
		planId,
		phaseNumber,
		declaredScope,
		actualFiles,
	} = args;

	const { declared, actual, undeclared, unused, divergenceRatio } =
		computeDivergence(declaredScope, actualFiles);

	// Idempotency per (planId, taskId): a retried call that would record the
	// SAME declared/actual sets as the latest record for this task is a
	// no-op (returns that record, `duplicate: true`). A rework with different
	// sets appends a new record, which supersedes the earlier one for
	// calibration (`latestRecordPerTask`).
	if (planId !== undefined) {
		const prior = findLatestRecordForTask(directory, planId, taskId);
		if (
			prior !== null &&
			sameStringArray(prior.declaredScope, declared) &&
			sameStringArray(prior.actualFiles, actual)
		) {
			return {
				path: path.join(directory, EVIDENCE_REL_DIR, EVIDENCE_FILE),
				record: prior,
				duplicate: true,
			};
		}
	}

	const record: DivergenceRecord = {
		timestamp: new Date().toISOString(),
		sessionID,
		taskId,
		...(planId !== undefined ? { planId } : {}),
		phaseNumber,
		declaredScope: declared,
		actualFiles: actual,
		undeclared,
		unused,
		divergenceRatio,
		isClean: divergenceRatio === 0,
	};

	let evidenceDir: string;
	try {
		evidenceDir = path.join(directory, EVIDENCE_REL_DIR);
		fs.mkdirSync(evidenceDir, { recursive: true });
	} catch (err) {
		logger.warn(
			`[epic/divergence] could not create ${EVIDENCE_REL_DIR}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}

	const filePath = path.join(evidenceDir, EVIDENCE_FILE);
	try {
		fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
		// #2483: write-side byte cap — compact immediately after the append so
		// the file exceeds MAX_DIVERGENCE_BYTES only transiently (by at most
		// one record) and is never emptied by compaction.
		compactToByteCap(filePath);
	} catch (err) {
		logger.warn(
			`[epic/divergence] append failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
	return { path: filePath, record };
}

function sameStringArray(
	a: readonly string[] | undefined,
	b: readonly string[],
): boolean {
	if (!Array.isArray(a) || a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
}

function findLatestRecordForTask(
	directory: string,
	planId: string,
	taskId: string,
): DivergenceRecord | null {
	let latest: DivergenceRecord | null = null;
	for (const record of readDivergenceHistory(directory)) {
		if (record.planId === planId && record.taskId === taskId) latest = record;
	}
	return latest;
}

/**
 * Collapse records to the LATEST one per `(planId, taskId)`, preserving the
 * chronological position of each surviving record. Records without a
 * `planId` (written before the field existed) are kept as-is — they cannot
 * be keyed safely across plans. Pure.
 */
export function latestRecordPerTask(
	records: readonly DivergenceRecord[],
): DivergenceRecord[] {
	const lastIndex = new Map<string, number>();
	records.forEach((record, index) => {
		if (typeof record.planId === 'string') {
			lastIndex.set(`${record.planId}\u0000${record.taskId}`, index);
		}
	});
	return records.filter(
		(record, index) =>
			typeof record.planId !== 'string' ||
			lastIndex.get(`${record.planId}\u0000${record.taskId}`) === index,
	);
}

export interface ReadDivergenceHistoryOptions {
	/** Read at most this many of the most recent records. */
	limit?: number;
	/** Filter to this session (default: all sessions). */
	sessionID?: string;
	/**
	 * Maximum bytes to read from the tail of the file. Defaults to
	 * `MAX_TAIL_BYTES` (16 MiB) — large enough to hold thousands of
	 * records, small enough to avoid OOMing on a runaway audit log.
	 * Pass `Infinity` to disable the bound (callers that truly need the
	 * whole history — adversarial review H3).
	 */
	maxBytes?: number;
}

/** 16 MiB cap on a single read of divergence.jsonl. */
const MAX_TAIL_BYTES = 16 * 1024 * 1024;

/**
 * Read divergence records from disk, oldest-to-newest within the read
 * window. Malformed lines (rare — could occur on partial write) are
 * silently skipped — they do not corrupt the well-formed records before or
 * after them. Returns `[]` when the file does not exist.
 *
 * Tail-bounded: by default reads at most the last `MAX_TAIL_BYTES`. When
 * the file is larger, the read starts mid-file and the FIRST encountered
 * line (which is almost certainly a partial record split by the byte
 * boundary) is discarded. This means very old records are not returned by
 * a default-bounded read — the calibration engine consumes the tail
 * incrementally via `processedRecords`, so it never needs the full history
 * in memory at once. For full-history audit reads (tests, ad-hoc tooling),
 * pass `maxBytes: Infinity`.
 */
export function readDivergenceHistory(
	directory: string,
	options?: ReadDivergenceHistoryOptions,
): DivergenceRecord[] {
	const filePath = path.join(directory, EVIDENCE_REL_DIR, EVIDENCE_FILE);
	if (!fs.existsSync(filePath)) {
		return [];
	}
	const maxBytes = options?.maxBytes ?? MAX_TAIL_BYTES;
	let raw: string;
	let tailTruncated = false;
	try {
		const stat = fs.statSync(filePath);
		if (Number.isFinite(maxBytes) && stat.size > maxBytes) {
			const fd = fs.openSync(filePath, 'r');
			try {
				const buf = Buffer.alloc(maxBytes);
				const offset = stat.size - maxBytes;
				fs.readSync(fd, buf, 0, maxBytes, offset);
				raw = buf.toString('utf-8');
				tailTruncated = true;
			} finally {
				try {
					fs.closeSync(fd);
				} catch {
					// already closed
				}
			}
		} else {
			raw = fs.readFileSync(filePath, 'utf-8');
		}
	} catch {
		// File disappeared between existsSync and statSync, or stat/open
		// failed for another reason. Audit-only — return empty rather than
		// throw.
		return [];
	}
	const lines = raw.split('\n').filter((l) => l.trim().length > 0);
	// If we did a mid-file read, the first line is almost certainly a
	// fragment of a record split by the byte boundary — drop it.
	const startIdx = tailTruncated && lines.length > 0 ? 1 : 0;
	const records: DivergenceRecord[] = [];
	for (let i = startIdx; i < lines.length; i++) {
		try {
			const parsed = JSON.parse(lines[i]!) as DivergenceRecord;
			if (options?.sessionID && parsed.sessionID !== options.sessionID) {
				continue;
			}
			records.push(parsed);
		} catch {
			// Skip malformed line; do not corrupt the stream.
		}
	}
	if (options?.limit !== undefined && options.limit >= 0) {
		return records.slice(-options.limit);
	}
	return records;
}
