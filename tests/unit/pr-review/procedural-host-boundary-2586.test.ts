import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	CANDIDATE_DIAGNOSTIC_PREVIEW_CHARS,
	CANDIDATE_HEADERS,
	CANDIDATE_LEGACY_FIELD_COUNT,
	splitPipeFields,
} from '../../../src/background/candidate-contract.js';
import {
	type ArtifactInput,
	type ParseFlags,
	parseAndPersist,
} from '../../../src/background/candidate-parser.js';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
import { artifactRecord } from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #2586 AC7 — qualify each claimed procedural/alternate host profile
 * (B: native fresh-context subagents, C: no subagent mechanism) separately
 * from the controller-backed Profile A (docs/releases/v7.129.2.md and the
 * baseline skill's "Runtime Capability Profiles" section).
 *
 * Leg 1 proves the documented executable fallback is REAL: the
 * `[CANDIDATE]`/`[CLEAN]` row convention a Profile B/C orchestrator collects
 * verbatim from lane reports parses through the same production surface the
 * Profile A `parse_lane_candidates` tool uses (`parseAndPersist`,
 * src/background/candidate-parser.ts — called by
 * src/tools/parse-lane-candidates.ts), producing the same structured
 * candidate records, clean attestations, and durable sidecar JSONL. A
 * malformed ten-field row (unescaped pipe in prose) is a bounded diagnostic,
 * never a crash.
 *
 * Leg 2 pins the truthful pre-support refusals of the controller-only tools
 * when their host envelope is absent: `dispatch_lanes_async` without a
 * session client (`failure_class: 'no_client'`) and
 * `write_pr_review_artifact` before any workflow activation. Both are
 * bounded typed results. Neither names the Profile B/C row-convention
 * fallback — that disclosure currently lives only in the skill text, which
 * this fixture pins as a matrix-doc disclosure rather than editing
 * production code.
 *
 * The non-swarm-caller dispatch refusal on a booted host (agent not
 * registered) is already pinned by
 * tests/unit/pr-review/r02-non-swarm-caller-typed-terminal.test.ts leg A and
 * is deliberately NOT duplicated here.
 *
 * Leg 3 (profile detection) is OMITTED: no production profile-detection
 * helper exists for PR-review capability profiles — the A/B/C classification
 * lives only in the skill text (src/environment/profile.ts profiles the
 * OS/shell environment, not the tool list).
 */

const SESSION_ID = 'boundary-2586-orchestrator';
const CHILD_SESSION_ID = 'boundary-2586-explorer-child';
const HEAD_SHA = 'a'.repeat(40);
const CANDIDATE_LANE = 'correctness-state';
const CLEAN_LANE = 'security-trust';

/** Shallow seam snapshot; afterEach restores every key so overrides cannot leak. */
const originalDispatch = { ...dispatchInternals };
let directory = '';

function laneArtifactInput(batchId: string, text: string): ArtifactInput {
	return {
		output_ref: `L1:${'1'.repeat(64)}:${'2'.repeat(64)}:${'3'.repeat(64)}`,
		batchId,
		laneId: `${batchId}-lane-0`,
		agent: 'boundary-explorer',
		role: 'explorer',
		sessionId: CHILD_SESSION_ID,
		parentSessionId: SESSION_ID,
		digest: 'f'.repeat(64),
		text,
		artifact_status: 'ok',
		source: 'collect_lane_results',
		produced_at: new Date().toISOString(),
	};
}

function baseParseFlags(expectedLane: string): ParseFlags {
	return {
		accept_partial: false,
		accept_degraded: false,
		degraded: false,
		row_format_version: 1,
		producer: 'swarm-pr-review',
		expected_family: 'base_explorer',
		expected_lane: expectedLane,
	};
}

async function removeTempDir(): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await fs.rm(directory, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'EBUSY' && code !== 'ENOTEMPTY') throw error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}

/**
 * Leg 2 hang guard: a refusal surface must ANSWER, not stall. The deadline is
 * an assertion bound, not synchronization — the guarded calls are expected to
 * resolve in milliseconds.
 */
async function refuseWithoutHang<T>(call: () => Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error('controller surface did not answer')),
			5_000,
		);
	});
	try {
		return await Promise.race([call(), deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/** The durable sidecar the Profile A tool path writes; the fallback must land here too. */
async function sidecarLines(
	batchId: string,
): Promise<Array<Record<string, unknown>>> {
	const sidecarPath = path.join(
		directory,
		'.swarm',
		'lane-results',
		createHash('sha256').update(batchId).digest('hex'),
		'candidates.jsonl',
	);
	const raw = await fs.readFile(sidecarPath, 'utf-8');
	return raw
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
	directory = canonicalMkdtemp('pr-review-host-boundary-2586-');
});

afterEach(async () => {
	Object.assign(dispatchInternals, originalDispatch);
	await removeTempDir();
});

describe('procedural host boundary qualification (issue #2586, AC7)', () => {
	test('leg 1a: a Profile-B [CANDIDATE] row artifact extracts a structured candidate through the real parser surface', async () => {
		const batchId = 'boundary-2586-candidates';
		// Profile-B shape: a fresh-context subagent's prose report carrying the
		// documented row convention verbatim (marker + the canonical
		// CANDIDATE_HEADERS.base_explorer eleven-field grammar).
		const text = [
			'Explorer report for lane correctness-state against the bound diff.',
			CANDIDATE_HEADERS.base_explorer,
			[
				'[CANDIDATE]',
				'b-cand-01',
				CANDIDATE_LANE,
				'HIGH',
				'race_condition',
				'src/app/lock.ts:42',
				'Mutex is released twice on the error path',
				'lock released at line 42 then again in the finally block',
				'use-after-free corrupts sibling lane state',
				'MEDIUM',
				'HIGH_IMPACT',
				'STATE_INTEGRITY,WRITE_PATH',
			].join(' | '),
		].join('\n');

		const result = parseAndPersist(
			laneArtifactInput(batchId, text),
			baseParseFlags(CANDIDATE_LANE),
			{ projectRoot: directory },
		);

		expect(result.error_code).toBeUndefined();
		expect(result.sidecar_write_error).toBeUndefined();
		expect(result.candidates).toHaveLength(1);
		const candidate = result.candidates[0]!;
		expect(candidate).toMatchObject({
			record_type: 'candidate',
			row_format_family: 'base_explorer',
			candidate_id: 'b-cand-01',
			lane: CANDIDATE_LANE,
			micro_lane: null,
			severity: 'HIGH',
			category: 'race_condition',
			file_line: 'src/app/lock.ts:42',
			claim: 'Mutex is released twice on the error path',
			confidence: 'MEDIUM',
			risk_impact: 'HIGH_IMPACT',
			source_batch_id: batchId,
		});
		expect(candidate.risk_tags).toEqual(['STATE_INTEGRITY', 'WRITE_PATH']);
		expect(result.diagnostics).toMatchObject({
			candidate_count: 1,
			parse_errors: 0,
			malformed_rows: 0,
			clean_attestation_count: 0,
		});
		expect(result.invocation_envelope.format_families_detected).toContain(
			'base_explorer',
		);

		// The fallback lands in the SAME durable sidecar Profile A writes, so a
		// Profile B/C run's rows are mechanically indistinguishable downstream.
		const persisted = await sidecarLines(batchId);
		expect(persisted[0]).toMatchObject({ record_type: 'invocation' });
		expect(persisted[1]).toMatchObject({
			record_type: 'candidate',
			candidate_id: 'b-cand-01',
		});
	});

	test('leg 1b: a Profile-B [CLEAN] attestation row parses as a clean attestation and persists', async () => {
		const batchId = 'boundary-2586-clean';
		const text = [
			'Explorer report for lane security-trust against the bound diff.',
			CANDIDATE_HEADERS.base_explorer,
			[
				'[CLEAN]',
				CLEAN_LANE,
				'exact bound diff for the whole security surface',
				'registered child found no actionable defect on the bound diff',
			].join(' | '),
		].join('\n');

		const result = parseAndPersist(
			laneArtifactInput(batchId, text),
			baseParseFlags(CLEAN_LANE),
			{ projectRoot: directory },
		);

		expect(result.error_code).toBeUndefined();
		expect(result.candidates).toHaveLength(0);
		expect(result.clean_attestation).toMatchObject({
			record_type: 'clean_attestation',
			row_format_family: 'base_explorer',
			lane: CLEAN_LANE,
			coverage_scope: 'exact bound diff for the whole security surface',
			evidence: 'registered child found no actionable defect on the bound diff',
		});
		expect(result.diagnostics).toMatchObject({
			candidate_count: 0,
			parse_errors: 0,
			malformed_rows: 0,
			clean_attestation_count: 1,
		});

		const persisted = await sidecarLines(batchId);
		expect(persisted[0]).toMatchObject({ record_type: 'invocation' });
		expect(persisted[1]).toMatchObject({
			record_type: 'clean_attestation',
			lane: CLEAN_LANE,
		});
	});

	test('leg 1c: a malformed ten-field row (unescaped pipe in prose) is a bounded diagnostic, not a crash', () => {
		const batchId = 'boundary-2586-malformed';
		// A legacy nine-field row whose evidence prose carries one unescaped
		// pipe: splitPipeFields yields ten data fields — past the legacy width
		// the parser could normalize, short of the canonical eleven.
		const malformedRow = [
			'[CANDIDATE]',
			'b-bad-01',
			CANDIDATE_LANE,
			'MEDIUM',
			'race_condition',
			'src/app/lock.ts:7',
			'claim text',
			'evidence mentions a',
			'b',
			'impact context',
			'MEDIUM',
		].join(' | ');
		const dataFields = splitPipeFields(malformedRow).slice(1);
		expect(dataFields).toHaveLength(10);
		expect(dataFields.length).not.toBe(CANDIDATE_LEGACY_FIELD_COUNT);
		expect(dataFields.length).not.toBe(11);

		const result = parseAndPersist(
			laneArtifactInput(
				batchId,
				[CANDIDATE_HEADERS.base_explorer, malformedRow].join('\n'),
			),
			baseParseFlags(CANDIDATE_LANE),
			{ projectRoot: directory },
		);

		// Bounded typed diagnostic: the parse RETURNS, the row is counted
		// malformed, and the detail message stays under the production
		// diagnostic-preview bound instead of echoing the row or throwing.
		expect(result.candidates).toHaveLength(0);
		expect(result.clean_attestation).toBeUndefined();
		expect(result.diagnostics.malformed_rows).toBe(1);
		expect(result.diagnostics.parse_error_details).toHaveLength(1);
		const detail = result.diagnostics.parse_error_details[0]!;
		expect(detail.row_index).toBe(1);
		expect(detail.field).toBe('row');
		expect(detail.message).toContain('Structurally short [CANDIDATE] row');
		expect(detail.message.length).toBeLessThan(
			CANDIDATE_DIAGNOSTIC_PREVIEW_CHARS,
		);
		// The parser's own mismatch hint is the one production string that
		// points an operator back at the pipe-delimited row convention.
		expect(result.diagnostics.format_mismatch_hint).toContain(
			'pipe-delimited candidate rows',
		);
	});

	test('leg 2: controller-only tools refuse typed and bounded outside their support envelope, without naming the row-convention fallback', async () => {
		// (a) dispatch_lanes_async with no host session client — the envelope a
		// Profile B/C host presents to the controller tools — refuses with the
		// typed no_client class, having launched nothing.
		dispatchInternals.getSessionOps = () => null;
		const dispatchRefusal = await refuseWithoutHang(() =>
			executeDispatchLanesAsync(
				{
					batch_id: 'boundary-2586-no-host',
					lanes: [
						{
							id: 'boundary-lane-1',
							agent: 'explorer',
							prompt: 'Review the bound diff.',
						},
					],
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(dispatchRefusal).toMatchObject({
			success: false,
			failure_class: 'no_client',
			message: 'OpenCode session promptAsync client is not available',
			dispatched: 0,
			pending: 0,
			rejected: 0,
			lane_results: [],
		});
		expect(JSON.stringify(dispatchRefusal).length).toBeLessThan(32_768);

		// (b) write_pr_review_artifact before any workflow activation refuses
		// truthfully with the explicit support decision: it needs an active
		// head-bound PR_REVIEW workflow.
		const writeRaw = await refuseWithoutHang(() =>
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'boundary-2586-run',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_explorer',
					records: [
						artifactRecord('C-2586-1', 'PENDING', 'route_to_reviewer', 'HIGH'),
					],
				},
				directory,
				{ sessionID: 'boundary-2586-no-activation' },
			),
		);
		expect(writeRaw.length).toBeLessThan(32_768);
		const writeRefusal = JSON.parse(writeRaw) as {
			success: boolean;
			message: string;
		};
		expect(writeRefusal.success).toBe(false);
		expect(writeRefusal.message).toContain(
			'an active head-bound "PR_REVIEW" workflow',
		);

		// (c) DISCLOSURE PIN: both refusal texts tell the caller what they need,
		// but neither names the documented Profile B/C executable fallback (the
		// [CANDIDATE]/[CLEAN] row convention parsed from lane reports) nor the
		// parser. This is the gap the #2586 matrix doc must disclose; pinned
		// here instead of editing production refusal text.
		const dispatchText = JSON.stringify(dispatchRefusal);
		for (const token of [
			'[CANDIDATE]',
			'parse_lane_candidates',
			'row convention',
			'Profile B',
		]) {
			expect(dispatchText).not.toContain(token);
			expect(writeRaw).not.toContain(token);
		}
	});
});
