import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { PR_REVIEW_FINDINGS_MAX_BYTES } from '../background/pr-review-contract.js';
import {
	PR_REVIEW_REQUIRED_TRIGGER_IDS,
	PR_REVIEW_TRIGGER_RECEIPT_MAX_BYTES,
} from '../background/pr-review-trigger-contract.js';
import { readCoreEvents } from '../events/core-events.js';
import { readPrWorkflowGateState } from '../hooks/pr-workflow-gate.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { isoNow } from '../pr-review/persistence.js';
import {
	type RendererFinding,
	renderPrReviewSubmissionBody,
} from '../pr-review/render-review-body.js';
import { createSwarmTool } from './create-tool.js';

/**
 * Post-abort partial-results export (issue #3097, Workstream C PR 2/2).
 *
 * A PR_REVIEW workflow that legitimately ends via `abort_pr_workflow` has no
 * authorized export of its validated findings: the live handoff path requires
 * an active gate (`write_pr_review_artifact` entry check) and couples to
 * feedback consent, while `pr_review_submission` refuses aborted runs by
 * design. This tool is the missing third surface: it requires the gate to be
 * GONE and an abort event to bind the session + head, reads the surviving run
 * artifacts (run reservation, trigger-eval receipt, findings), and writes a
 * partial, explicitly NON-AUTHORITATIVE export artifact. It never implies
 * review completion or feedback consent: it does not touch the
 * feedback-consent machinery, never writes the handoff completion marker, and
 * issues no verdict.
 */

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PR_HEAD_SHA_PATTERN = /^[0-9a-f]{6,64}$/i;

const ExportArgsSchema = z
	.object({
		run_id: z.string().trim().regex(RUN_ID_PATTERN),
		pr_head_sha: z.string().trim().regex(PR_HEAD_SHA_PATTERN),
	})
	.strict();

type ExportRefusalType =
	| 'invalid-args'
	| 'invalid-session'
	| 'gate-active'
	| 'gate-indeterminate'
	| 'not-aborted'
	| 'abort-scan-indeterminate'
	| 'reservation-mismatch'
	| 'receipt-missing'
	| 'head-mismatch'
	| 'no-findings'
	| 'invalid-findings'
	| 'artifact-too-large'
	| 'io-error';

/** Findings artifact cap + envelope/summary margin; refusal is typed, never truncation. */
const POST_ABORT_EXPORT_MAX_BYTES = PR_REVIEW_FINDINGS_MAX_BYTES + 1024 * 1024;
const RESERVATION_MAX_BYTES = 16 * 1024;

interface AbortEvent {
	timestamp: string;
	openLanes?: number;
	presumedStaleLanes?: string[];
}

interface ReceiptShape {
	run_id?: unknown;
	pr_head_sha?: unknown;
	base_ref?: unknown;
	base_sha?: unknown;
	evaluated_at?: unknown;
	rows?: unknown;
	coverage_degradations?: unknown;
}

interface PersistedFindingRow {
	finding_id: string;
	status: string;
	file_line: string;
	evidence: string;
	next_action: string;
	severity?: string;
	critic_status?: string;
	provenance?: string[];
	boundary: string;
	pr_head_sha: string;
	recorded_at: string;
}

function failure(type: ExportRefusalType, message: string): string {
	return JSON.stringify({ success: false, type, message });
}

function success(result: Record<string, unknown>): string {
	return JSON.stringify({ success: true, ...result });
}

/**
 * Bounded abort scan over the retained core-events window (the
 * `hasAbortAfterSettlement` predicates of #3118, inverted: an abort is the
 * PRECONDITION). Returns the newest matching event; `truncated` coverage
 * fails closed because the abort may sit beyond the read bound.
 */
export function findAbortEventForHead(
	directory: string,
	sessionID: string,
	headSha: string,
): { event: AbortEvent | null; indeterminate: boolean } {
	const read = readCoreEvents(directory);
	if (read.coverage === 'truncated')
		return { event: null, indeterminate: true };
	const head = headSha.toLowerCase();
	let match: AbortEvent | null = null;
	for (const line of read.text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (parsed.type !== 'pr_workflow_aborted') continue;
		if (parsed.sessionID !== sessionID) continue;
		const mode = parsed.mode;
		if (mode !== undefined && mode !== 'PR_REVIEW') continue;
		const eventHead =
			typeof parsed.prHeadSha === 'string'
				? parsed.prHeadSha.toLowerCase()
				: null;
		if (eventHead !== head) continue;
		match = {
			timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
			openLanes: typeof parsed.openLanes === 'number' ? parsed.openLanes : 0,
			presumedStaleLanes: Array.isArray(parsed.presumedStaleLanes)
				? parsed.presumedStaleLanes.filter(
						(entry): entry is string => typeof entry === 'string',
					)
				: [],
		};
	}
	return { event: match, indeterminate: false };
}

async function readBoundedJson(
	absolutePath: string,
	maxBytes: number,
): Promise<Record<string, unknown>> {
	const stat = await fs.promises.stat(absolutePath);
	if (!stat.isFile() || stat.size > maxBytes) {
		throw new Error(`not a bounded regular file (max ${maxBytes} bytes)`);
	}
	const text = await fs.promises.readFile(absolutePath, 'utf8');
	if (Buffer.byteLength(text, 'utf8') > maxBytes) {
		throw new Error(`exceeds ${maxBytes} bytes after read`);
	}
	const decoded = JSON.parse(text) as unknown;
	if (
		decoded === null ||
		typeof decoded !== 'object' ||
		Array.isArray(decoded)
	) {
		throw new Error('not a JSON object');
	}
	return decoded as Record<string, unknown>;
}

function readFindingsRows(text: string): PersistedFindingRow[] {
	const rows: PersistedFindingRow[] = [];
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined || line.trim() === '') continue;
		let decoded: unknown;
		try {
			decoded = JSON.parse(line);
		} catch (error) {
			throw new Error(
				`line ${index + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (decoded === null || typeof decoded !== 'object') {
			throw new Error(`line ${index + 1} is not a findings record`);
		}
		const record = decoded as Record<string, unknown>;
		const findingId = typeof record.finding_id === 'string';
		const required =
			findingId &&
			typeof record.status === 'string' &&
			typeof record.file_line === 'string' &&
			typeof record.evidence === 'string' &&
			typeof record.next_action === 'string' &&
			typeof record.boundary === 'string' &&
			typeof record.pr_head_sha === 'string' &&
			typeof record.recorded_at === 'string';
		if (!required) {
			throw new Error(
				`line ${index + 1} violates the persisted findings shape`,
			);
		}
		rows.push({
			finding_id: record.finding_id as string,
			status: record.status as string,
			file_line: record.file_line as string,
			evidence: record.evidence as string,
			next_action: record.next_action as string,
			...(typeof record.severity === 'string'
				? { severity: record.severity }
				: {}),
			...(typeof record.critic_status === 'string'
				? { critic_status: record.critic_status }
				: {}),
			...(Array.isArray(record.provenance)
				? {
						provenance: record.provenance.filter(
							(entry): entry is string => typeof entry === 'string',
						),
					}
				: {}),
			boundary: record.boundary as string,
			pr_head_sha: record.pr_head_sha as string,
			recorded_at: record.recorded_at as string,
		});
	}
	return rows;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${randomUUID()}.tmp`,
	);
	try {
		await fs.promises.writeFile(tempPath, content, {
			encoding: 'utf8',
			flag: 'wx',
		});
		await fs.promises.rename(tempPath, filePath);
	} finally {
		await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
	}
}

function safeSwarmPath(directory: string, relativePath: string): string | null {
	try {
		return validateSwarmPath(directory, relativePath);
	} catch {
		return null;
	}
}

/**
 * Single-return path helper for the export WRITE site: the G2 evidence-class
 * scanner folds a write target only when it resolves through path.join /
 * validateSwarmPath / a same-file single-return helper (the #3118
 * payloadArtifactPath precedent), so the write keeps a plain string target.
 */
function exportArtifactPath(directory: string, runId: string): string {
	return validateSwarmPath(
		directory,
		path.join('pr-review', runId, 'post-abort-export.json'),
	);
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/** Silence computation: absence is listed, never smoothed over. */
function computeSilence(
	receipt: ReceiptShape,
	abortEvent: AbortEvent,
): {
	untestedFamilies: string[];
	notTriggeredFamilies: string[];
	familiesSource: string;
} {
	const receiptRows = Array.isArray(receipt.rows) ? receipt.rows : [];
	const degraded = new Set(
		(Array.isArray(receipt.coverage_degradations)
			? receipt.coverage_degradations
			: []
		)
			.map((entry) =>
				entry &&
				typeof entry === 'object' &&
				typeof (entry as Record<string, unknown>).trigger_id === 'string'
					? ((entry as Record<string, unknown>).trigger_id as string)
					: null,
			)
			.filter((entry): entry is string => entry !== null),
	);
	const matchedFamilies = new Set<string>();
	const notTriggered: string[] = [];
	const matchedLaneByFamily = new Map<string, string>();
	for (const entry of receiptRows) {
		if (entry === null || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;
		const triggerId = asString(row.trigger_id);
		if (!triggerId) continue;
		if (row.result === 'MATCHED') {
			matchedFamilies.add(triggerId);
			const laneId = asString(row.source_lane_id);
			if (laneId) matchedLaneByFamily.set(triggerId, laneId);
		} else if (row.result === 'NOT_TRIGGERED') {
			notTriggered.push(triggerId);
		}
	}
	const presumedStale = new Set(abortEvent.presumedStaleLanes ?? []);
	const untested: string[] = [];
	for (const family of PR_REVIEW_REQUIRED_TRIGGER_IDS) {
		if (!matchedFamilies.has(family)) {
			// Canonical family with no MATCHED row: either never evaluated in
			// the retained receipt (absent entirely) or explicitly not
			// triggered. Only the absent case is silence.
			if (!notTriggered.includes(family)) untested.push(family);
			continue;
		}
		if (degraded.has(family)) {
			untested.push(family);
			continue;
		}
		const laneId = matchedLaneByFamily.get(family);
		if (laneId && presumedStale.has(laneId)) untested.push(family);
	}
	return {
		untestedFamilies: untested,
		notTriggeredFamilies: notTriggered,
		familiesSource: Array.isArray(receipt.rows)
			? 'v2-rows'
			: 'v1-receipt-no-rows',
	};
}

function renderSummary(input: {
	runId: string;
	head: string;
	workflowInstanceId: string;
	abortedAt: string;
	receipt: ReceiptShape;
	rows: PersistedFindingRow[];
	untestedFamilies: string[];
	notTriggeredFamilies: string[];
	boundariesReached: string[];
	baseCoverage: { status: string; unresolved_dimensions?: string[] };
	familiesSource: string;
	abortEvent: AbortEvent;
}): string {
	const coverage =
		input.baseCoverage.status === 'unresolved' &&
		input.baseCoverage.unresolved_dimensions &&
		input.baseCoverage.unresolved_dimensions.length > 0
			? {
					kind: 'PARTIAL (post-abort)',
					unresolved_dimensions: input.baseCoverage.unresolved_dimensions,
				}
			: {
					kind: 'UNKNOWN (post-abort; no coverage-disclosure.json)',
					unresolved_dimensions: [
						'base-dimension coverage not settled (no partial-base-coverage admission found)',
					],
				};
	const rendererFindings: RendererFinding[] = input.rows.map((row) => ({
		finding_id: row.finding_id,
		status: row.status,
		file_line: row.file_line,
		evidence: row.evidence,
		next_action: row.next_action,
		severity: row.severity ?? 'NONE',
	}));
	const rendered = renderPrReviewSubmissionBody({
		run_id: input.runId,
		pr_head_sha: input.head,
		coverage,
		findings: rendererFindings,
	});
	const lines: string[] = [];
	lines.push(
		`> PARTIAL — NON-AUTHORITATIVE post-abort salvage export for run ${input.runId} at head ${input.head}.`,
	);
	lines.push(
		'> This is NOT a review submission, NOT review completion, and implies NO feedback consent. The review ended via abort_pr_workflow; the findings below are the run-bound validated partial record only.',
	);
	lines.push(
		`> Provenance: workflow_instance ${input.workflowInstanceId}; aborted_at ${input.abortedAt}; trigger receipt evaluated_at ${asString(input.receipt.evaluated_at) ?? '(absent)'} at base ${asString(input.receipt.base_sha) ?? '(absent)'} (${asString(input.receipt.base_ref) ?? '(absent)'}).`,
	);
	lines.push('');
	lines.push(rendered.body);
	lines.push('');
	lines.push('## Silence disclosure');
	lines.push(
		input.untestedFamilies.length > 0
			? `- Untested families (assigned-but-receiptless or coverage-degraded; listed, not smoothed over): ${input.untestedFamilies.join(', ')}`
			: '- Untested families: none recorded in the retained trigger receipt.',
	);
	if (input.notTriggeredFamilies.length > 0) {
		lines.push(
			`- Evaluated, not triggered: ${input.notTriggeredFamilies.join(', ')}`,
		);
	}
	lines.push(
		`- Boundaries reached: ${input.boundariesReached.length > 0 ? input.boundariesReached.join(', ') : '(none)'}`,
	);
	lines.push(
		`- Base coverage: ${input.baseCoverage.status}${input.baseCoverage.unresolved_dimensions && input.baseCoverage.unresolved_dimensions.length > 0 ? ` (${input.baseCoverage.unresolved_dimensions.join(', ')})` : ''}.`,
	);
	lines.push(
		`- Abort lane state: open_lanes ${input.abortEvent.openLanes ?? 0}; presumed-stale lanes ${(input.abortEvent.presumedStaleLanes ?? []).length > 0 ? (input.abortEvent.presumedStaleLanes ?? []).join(', ') : '(none disclosed)'}. Lanes settled uncollected at abort are NOT claimed as tested.`,
	);
	if (input.familiesSource === 'v1-receipt-no-rows') {
		lines.push(
			'- Family evidence source: legacy v1 trigger receipt carries no per-family rows; family silence cannot be attributed.',
		);
	}
	lines.push(
		'> Family-level lane settlement receipts live in the delegation ledger, which this export deliberately does not read; no family-level settlement is claimed.',
	);
	return lines.join('\n');
}

export const _internals = {
	atomicWrite,
	findAbortEventForHead,
};

export async function executeExportPrReviewPartialResults(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = ExportArgsSchema.safeParse(args);
	if (!parsed.success) {
		return failure(
			'invalid-args',
			`Invalid post-abort export args: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		);
	}
	const sessionID = context.sessionID?.trim();
	if (!sessionID)
		return failure('invalid-session', 'an active sessionID is required');
	const runId = parsed.data.run_id;
	const declaredHead = parsed.data.pr_head_sha.toLowerCase();

	// Gate must be GONE: while a gate is active the live handoff path is the
	// only authorized surface (and this tool must never become a parallel
	// live path around the consent machinery).
	let gateState: Awaited<ReturnType<typeof readPrWorkflowGateState>>;
	try {
		gateState = await readPrWorkflowGateState(directory, sessionID);
	} catch (error) {
		return failure(
			'gate-indeterminate',
			`could not read the PR workflow gate state: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (gateState !== null) {
		return failure(
			'gate-active',
			'an active PR workflow gate exists for this session; the live handoff path remains the authorized surface until the workflow is aborted',
		);
	}

	// Abort evidence is the precondition (the #3118 abort scan, inverted).
	const abortScan = _internals.findAbortEventForHead(
		directory,
		sessionID,
		declaredHead,
	);
	if (abortScan.indeterminate) {
		return failure(
			'abort-scan-indeterminate',
			'the retained events window is truncated; abort evidence for the declared head cannot be verified',
		);
	}
	const abortEvent = abortScan.event;
	if (!abortEvent || abortEvent.timestamp === '') {
		return failure(
			'not-aborted',
			`no pr_workflow_aborted event binds session ${sessionID} to head ${declaredHead}`,
		);
	}

	const relativeRunDir = path.join('pr-review', runId);
	const resolve = (name: string): string | null =>
		safeSwarmPath(directory, path.join(relativeRunDir, name));

	// Run reservation: proves the run belongs to this session and carries the
	// workflow instance identity (closes the cross-session gap #3118 disclosed).
	const reservationPath = resolve('run-reservation.json');
	if (!reservationPath) {
		return failure(
			'invalid-args',
			`run_id "${runId}" does not resolve to a contained path below the project .swarm directory`,
		);
	}
	let reservation: Record<string, unknown>;
	try {
		reservation = await readBoundedJson(reservationPath, RESERVATION_MAX_BYTES);
	} catch (error) {
		return failure(
			'reservation-mismatch',
			`expected a bounded readable run reservation for run "${runId}": ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (reservation.session_id !== sessionID || reservation.run_id !== runId) {
		return failure(
			'reservation-mismatch',
			`run "${runId}" is reserved by session ${JSON.stringify(reservation.session_id)}, not the calling session`,
		);
	}
	const workflowInstanceId = asString(reservation.workflow_instance_id) ?? '';

	// Trigger-eval receipt: the run/head/base binding evidence.
	const receiptPath = resolve('trigger-eval.json');
	if (!receiptPath) {
		return failure('invalid-args', 'trigger-eval path failed containment');
	}
	let receipt: ReceiptShape;
	try {
		receipt = (await readBoundedJson(
			receiptPath,
			PR_REVIEW_TRIGGER_RECEIPT_MAX_BYTES,
		)) as ReceiptShape;
	} catch (error) {
		return failure(
			'receipt-missing',
			`expected a bounded readable trigger-eval receipt for run "${runId}": ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const receiptRunId = asString(receipt.run_id);
	const receiptHead = asString(receipt.pr_head_sha);
	if (receiptRunId !== runId || !receiptHead) {
		return failure(
			'head-mismatch',
			`trigger-eval receipt does not bind run "${runId}" (bound ${JSON.stringify(receiptRunId)})`,
		);
	}
	if (receiptHead.toLowerCase() !== declaredHead) {
		return failure(
			'head-mismatch',
			`trigger-eval receipt binds head ${receiptHead}, not the declared head ${declaredHead}`,
		);
	}

	// Findings: every persisted row must bind to the declared head.
	const findingsPath = resolve('findings.jsonl');
	if (!findingsPath) {
		return failure('invalid-args', 'findings path failed containment');
	}
	let findingsText: string;
	try {
		const stat = await fs.promises.stat(findingsPath);
		if (!stat.isFile() || stat.size > PR_REVIEW_FINDINGS_MAX_BYTES) {
			throw new Error(
				`not a bounded regular file (max ${PR_REVIEW_FINDINGS_MAX_BYTES} bytes)`,
			);
		}
		findingsText = await fs.promises.readFile(findingsPath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return failure(
				'no-findings',
				`no findings artifact exists for run "${runId}"`,
			);
		}
		return failure(
			'invalid-findings',
			`could not read the findings artifact: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	let rows: PersistedFindingRow[];
	try {
		rows = readFindingsRows(findingsText);
	} catch (error) {
		return failure(
			'invalid-findings',
			`the findings artifact violates the persisted findings shape: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (rows.length === 0) {
		return failure(
			'no-findings',
			`run "${runId}" persisted zero findings rows; there is no validated partial record to export`,
		);
	}
	for (const row of rows) {
		if (row.pr_head_sha.toLowerCase() !== declaredHead) {
			return failure(
				'head-mismatch',
				`finding ${row.finding_id} binds head ${row.pr_head_sha}, not the declared head ${declaredHead}`,
			);
		}
	}

	// Optional coverage disclosure (partial base coverage admitted pre-abort).
	let baseCoverage: { status: string; unresolved_dimensions?: string[] } = {
		status: 'unknown',
	};
	const disclosurePath = resolve('coverage-disclosure.json');
	if (disclosurePath) {
		try {
			const disclosure = await readBoundedJson(
				disclosurePath,
				PR_REVIEW_FINDINGS_MAX_BYTES,
			);
			const unresolved = Array.isArray(disclosure.unresolvedDimensions)
				? disclosure.unresolvedDimensions
				: [];
			const dimensions = unresolved
				.map((entry) =>
					entry &&
					typeof entry === 'object' &&
					typeof (entry as Record<string, unknown>).dimension === 'string'
						? ((entry as Record<string, unknown>).dimension as string)
						: null,
				)
				.filter((entry): entry is string => entry !== null);
			baseCoverage = {
				status: 'unresolved',
				unresolved_dimensions: dimensions,
			};
		} catch {
			// Unreadable disclosure keeps the honest unknown status; it is
			// optional provenance, not authorization evidence.
		}
	}

	const boundariesReached = [...new Set(rows.map((row) => row.boundary))];
	const silence = computeSilence(receipt, abortEvent);
	const exportedAt = isoNow();
	const artifact = {
		kind: 'post-abort-partial-export' as const,
		schema_version: 1,
		partial: true,
		authoritative: false,
		run_id: runId,
		pr_head_sha: declaredHead,
		workflow_instance_id: workflowInstanceId,
		aborted_at: abortEvent.timestamp,
		exported_at: exportedAt,
		provenance: {
			base_ref: asString(receipt.base_ref) ?? '',
			base_sha: asString(receipt.base_sha) ?? '',
			evaluated_at: asString(receipt.evaluated_at) ?? '',
			receipt_run_id: receiptRunId ?? '',
			receipt_pr_head_sha: receiptHead,
		},
		findings: rows.map((row) => ({
			finding_id: row.finding_id,
			status: row.status,
			file_line: row.file_line,
			evidence: row.evidence,
			next_action: row.next_action,
			severity: row.severity ?? 'NONE',
			lane: row.boundary,
			...(row.critic_status !== undefined
				? { critic_status: row.critic_status }
				: {}),
			recorded_at: row.recorded_at,
			provenance: row.provenance ?? [],
		})),
		silence: {
			untested_families: silence.untestedFamilies,
			not_triggered_families: silence.notTriggeredFamilies,
			boundaries_reached: boundariesReached,
			base_coverage: baseCoverage,
			families_source: silence.familiesSource,
		},
		abort_lane_state: {
			open_lanes: abortEvent.openLanes ?? 0,
			presumed_stale_lane_ids: abortEvent.presumedStaleLanes ?? [],
			note: 'lanes settled uncollected at abort are not claimed as tested',
		},
		summary: renderSummary({
			runId,
			head: declaredHead,
			workflowInstanceId,
			abortedAt: abortEvent.timestamp,
			receipt,
			rows,
			untestedFamilies: silence.untestedFamilies,
			notTriggeredFamilies: silence.notTriggeredFamilies,
			boundariesReached,
			baseCoverage,
			familiesSource: silence.familiesSource,
			abortEvent,
		}),
	};
	const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
	const serializedBytes = Buffer.byteLength(serialized, 'utf8');
	if (serializedBytes > POST_ABORT_EXPORT_MAX_BYTES) {
		return failure(
			'artifact-too-large',
			`the export artifact would be ${serializedBytes} bytes (cap ${POST_ABORT_EXPORT_MAX_BYTES}); refusing rather than truncating`,
		);
	}
	let exportPath: string;
	try {
		exportPath = exportArtifactPath(directory, runId);
	} catch (error) {
		return failure(
			'invalid-args',
			`run_id "${runId}" does not resolve to a contained export path: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		await _internals.atomicWrite(exportPath, serialized);
	} catch (error) {
		return failure(
			'io-error',
			`the export artifact could not be written: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const relativeExportPath = path
		.join(relativeRunDir, 'post-abort-export.json')
		.split(path.sep)
		.join('/');
	return success({
		run_id: runId,
		pr_head_sha: declaredHead,
		path: relativeExportPath,
		finding_count: rows.length,
		untested_family_count: silence.untestedFamilies.length,
		partial: true,
		authoritative: false,
	});
}

export const export_pr_review_partial_results: ReturnType<
	typeof createSwarmTool
> = createSwarmTool({
	allowWorkingDirectoryOverride: true,
	description:
		'Export the validated partial results of an ABORTED PR_REVIEW run as a partial, non-authoritative artifact bound per-item to receipt-authenticated findings (issue #3097). Requires the PR workflow gate to be cleared and a pr_workflow_aborted event binding the session and declared pr_head_sha; verifies the run reservation belongs to the calling session and the trigger-eval receipt and every persisted findings row bind to the declared head. Writes .swarm/pr-review/<run_id>/post-abort-export.json with per-item lane/severity/provenance disclosure, silence representation (assigned-but-receiptless families listed as untested), and an explicit PARTIAL / NON-AUTHORITATIVE banner. Never implies review completion or feedback consent: does not touch feedback-consent.json or the handoff completion marker, and refuses while a gate is still active. Idempotent re-export.',
	args: {
		run_id: ExportArgsSchema.shape.run_id,
		pr_head_sha: ExportArgsSchema.shape.pr_head_sha,
	},
	execute: executeExportPrReviewPartialResults,
});
