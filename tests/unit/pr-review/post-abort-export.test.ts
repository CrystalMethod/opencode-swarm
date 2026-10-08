/**
 * Issue #3097 INDEPENDENT CHECK: post-abort export of PR_REVIEW partial
 * results (`export_pr_review_partial_results`).
 *
 * Frozen spec these checks encode (do not weaken):
 * - Fail-closed authorization ladder, each typed: `invalid-session` ->
 *   `gate-active` / `gate-indeterminate` -> `not-aborted` /
 *   `abort-scan-indeterminate` (bounded `.swarm/events.jsonl` tail scan
 *   mirroring `hasAbortAfterSettlement`) -> `reservation-mismatch` ->
 *   `receipt-missing` / `head-mismatch` -> `no-findings`.
 * - Success atomically writes `.swarm/pr-review/<run_id>/post-abort-export.json`
 *   with kind 'post-abort-partial-export', partial true, authoritative false,
 *   a silence disclosure block, and a summary whose banner carries the literal
 *   'PARTIAL' and 'NON-AUTHORITATIVE' markers.
 * - The export never creates or modifies `feedback-consent.json` or
 *   `feedback-handoff.json` and never resurrects gate state.
 *
 * Test-name filter contract (bun -t): the AC2 arm name contains the word
 * "consent", the AC3 arm name contains "silence", and the AC4 arm name
 * contains "non-authoritative"; NO other test name in this file may contain
 * any of those three words.
 *
 * No mock.module. Real git fixture per test; the durable run artifacts are
 * seeded exactly as a partially-settled run leaves them (run-reservation.json,
 * strict v2 trigger-eval receipt built through the production
 * `buildPrReviewTriggerReceiptV2`, findings.jsonl satisfying
 * PrReviewFindingSchema).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildPrReviewTriggerReceiptV2,
	PR_REVIEW_TRIGGER_DEFINITIONS,
} from '../../../src/background/pr-review-trigger-contract.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	abortPrWorkflow,
	activatePrWorkflow,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeExportPrReviewPartialResults } from '../../../src/tools/export-pr-review-partial-results.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

const SESSION = 'sess-3097-check';
const RUN_ID = 'run-3097-check';
const BASE_SHA = 'b'.repeat(40);
const BASE_REF = 'main';
const RESERVED_AT = '2026-10-08T00:00:01.000Z';
const EVALUATED_AT = '2026-10-08T00:00:02.000Z';
const RECORDED_AT = '2026-10-08T00:00:03.000Z';
const DEGRADED_FAMILY = 'auth-identity-secrets';
const CLEAN_FAMILY = 'subprocess-platform';
const NOT_TRIGGERED_FAMILY = 'ui-accessibility-i18n';
const GIT_TIMEOUT_MS = 30_000;

/** Fixture state, rebuilt by prepareActiveWorkflow/prepareAbortedWorkflow. */
let projectRoot = '';
let head = '';
let runDir = '';
let workflowInstanceId = '';

interface ExportResult {
	success?: boolean;
	type?: string;
	message?: string;
}

interface SeedOptions {
	/** Session recorded in run-reservation.json (reservation-mismatch arm). */
	reservationSession?: string;
	/** Omit trigger-eval.json entirely (receipt-missing arm). */
	writeTriggerEval?: boolean;
	/** Row count for findings.jsonl; 0 writes an empty file (no-findings arm). */
	findingsRowCount?: number;
	/** Head every findings row binds to (head-mismatch / not-aborted arms). */
	findingsHead?: string;
	/** Head the trigger receipt binds to (not-aborted arm). */
	receiptHead?: string;
}

function git(args: string[]): string {
	return execFileSync('git', ['-C', projectRoot, ...args], {
		encoding: 'utf8',
		timeout: GIT_TIMEOUT_MS,
	}).trim();
}

function asRecord(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? (value as string[]) : [];
}

function buildReceipt(prHead: string): unknown {
	const rows = PR_REVIEW_TRIGGER_DEFINITIONS.map((definition) => {
		if (definition.id === NOT_TRIGGERED_FAMILY) {
			return {
				trigger_id: definition.id,
				result: 'NOT_TRIGGERED',
				evidence: `check fixture: ${definition.id} not triggered`,
			};
		}
		return {
			trigger_id: definition.id,
			result: 'MATCHED',
			evidence: `check fixture: ${definition.id} matched`,
			source_batch_id: 'batch-3097-check',
			source_lane_id: `lane-${definition.id}`,
		};
	});
	return buildPrReviewTriggerReceiptV2({
		run_id: RUN_ID,
		pr_head_sha: prHead,
		base_ref: BASE_REF,
		base_sha: BASE_SHA,
		evaluated_at: EVALUATED_AT,
		dispatched_micro_lane_count: 10,
		rows,
		coverage_degradations: [
			{
				trigger_id: DEGRADED_FAMILY,
				source_batch_id: 'batch-3097-check',
				source_lane_id: `lane-${DEGRADED_FAMILY}`,
				reason:
					'check fixture: degraded coverage after the retry budget was exhausted',
			},
		],
	});
}

function findingRow(index: number, prHead: string): Record<string, unknown> {
	const row: Record<string, unknown> = {
		finding_id: `F-3097-${index}`,
		status: index === 3 ? 'PENDING' : 'CONFIRMED',
		file_line: `src/example.ts:${10 * index}`,
		evidence: `check fixture finding ${index}`,
		next_action: 'report',
		boundary: index === 3 ? 'post_reviewer' : 'post_explorer',
		pr_head_sha: prHead,
		recorded_at: RECORDED_AT,
	};
	if (index === 1) {
		row.severity = 'MEDIUM';
		row.risk_impact = 'UNKNOWN';
		row.risk_tags = [];
		row.critic_status = 'UPHELD';
		row.provenance = [`lane:${CLEAN_FAMILY}`];
	} else if (index === 2) {
		row.severity = 'LOW';
		row.risk_impact = 'UNKNOWN';
		row.risk_tags = [];
	}
	return row;
}

function seedRunArtifacts(options: SeedOptions): void {
	runDir = path.join(projectRoot, '.swarm', 'pr-review', RUN_ID);
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(
		path.join(runDir, 'run-reservation.json'),
		JSON.stringify({
			schema_version: 1,
			session_id: options.reservationSession ?? SESSION,
			workflow_instance_id: workflowInstanceId,
			run_id: RUN_ID,
			reserved_at: RESERVED_AT,
		}),
	);
	if (options.writeTriggerEval !== false) {
		fs.writeFileSync(
			path.join(runDir, 'trigger-eval.json'),
			`${JSON.stringify(buildReceipt(options.receiptHead ?? head), null, 2)}\n`,
		);
	}
	const findingsHead = options.findingsHead ?? head;
	const count = options.findingsRowCount ?? 3;
	const lines: string[] = [];
	for (let index = 1; index <= count; index += 1) {
		lines.push(JSON.stringify(findingRow(index, findingsHead)));
	}
	fs.writeFileSync(
		path.join(runDir, 'findings.jsonl'),
		lines.length > 0 ? `${lines.join('\n')}\n` : '',
	);
}

async function prepareWorkflow(
	options: SeedOptions,
	abort: boolean,
): Promise<void> {
	projectRoot = canonicalMkdtemp('post-abort-export-');
	await initializeGitRepository(projectRoot);
	git([
		'-c',
		'user.email=t@e.invalid',
		'-c',
		'user.name=T',
		'commit',
		'--allow-empty',
		'-m',
		'init',
	]);
	head = git(['rev-parse', 'HEAD']);
	const state = await activatePrWorkflow(projectRoot, SESSION, 'PR_REVIEW', {
		prHeadSha: head,
	});
	workflowInstanceId =
		typeof state.workflowInstanceId === 'string' &&
		state.workflowInstanceId.length > 0
			? state.workflowInstanceId
			: 'unknown';
	seedRunArtifacts(options);
	if (abort) {
		await abortPrWorkflow(projectRoot, SESSION, {
			kind: 'recovery',
			reason: 'test abort',
		});
	}
}

async function prepareActiveWorkflow(options: SeedOptions = {}): Promise<void> {
	await prepareWorkflow(options, false);
}

async function prepareAbortedWorkflow(
	options: SeedOptions = {},
): Promise<void> {
	await prepareWorkflow(options, true);
}

async function runExport(prHead: string = head): Promise<ExportResult> {
	const raw = await executeExportPrReviewPartialResults(
		{ run_id: RUN_ID, pr_head_sha: prHead },
		projectRoot,
		{ sessionID: SESSION },
	);
	return JSON.parse(raw) as ExportResult;
}

async function exportAndRead(): Promise<Record<string, unknown>> {
	const result = await runExport();
	expect(result.success).toBe(true);
	return readExportArtifact();
}

function artifactPath(): string {
	return path.join(runDir, 'post-abort-export.json');
}

function readExportArtifact(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(artifactPath(), 'utf8')) as Record<
		string,
		unknown
	>;
}

function readAbortEventTimestamp(): string | null {
	const eventsPath = path.join(projectRoot, '.swarm', 'events.jsonl');
	const text = fs.readFileSync(eventsPath, 'utf8');
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') continue;
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			if (
				parsed.type === 'pr_workflow_aborted' &&
				parsed.sessionID === SESSION
			) {
				return typeof parsed.timestamp === 'string' ? parsed.timestamp : null;
			}
		} catch {
			// Skip malformed lines; the durable abort line is well-formed JSON.
		}
	}
	return null;
}

afterEach(() => {
	closeAllProjectDbs();
	if (projectRoot !== '') {
		try {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		} catch {
			// Windows EBUSY teardown flake — the assertions already ran.
		}
	}
	projectRoot = '';
	head = '';
	runDir = '';
	workflowInstanceId = '';
});

describe('post-abort partial results export (#3097)', () => {
	test('AC1 exports the validated findings of an aborted PR_REVIEW run', async () => {
		await prepareAbortedWorkflow();
		const artifact = await exportAndRead();
		expect(artifact.kind).toBe('post-abort-partial-export');
		expect(artifact.run_id).toBe(RUN_ID);
		expect(artifact.pr_head_sha).toBe(head);
		expect(artifact.workflow_instance_id).toBe(workflowInstanceId);
		expect(artifact.aborted_at).toBe(readAbortEventTimestamp());
		const provenance = asRecord(artifact.provenance);
		expect(provenance.base_ref).toBe(BASE_REF);
		expect(provenance.base_sha).toBe(BASE_SHA);
		expect(provenance.evaluated_at).toBe(EVALUATED_AT);
		expect(provenance.receipt_run_id).toBe(RUN_ID);
		expect(provenance.receipt_pr_head_sha).toBe(head);
		const findings = asStringArray(
			(artifact as { findings?: unknown }).findings,
		);
		expect(findings).toHaveLength(3);
		expect(findings.map((row) => asRecord(row).finding_id)).toEqual([
			'F-3097-1',
			'F-3097-2',
			'F-3097-3',
		]);
		const first = asRecord(findings[0]);
		expect(first.status).toBe('CONFIRMED');
		expect(first.severity).toBe('MEDIUM');
		expect(first.lane).toBe('post_explorer');
		expect(first.provenance).toEqual([`lane:${CLEAN_FAMILY}`]);
		expect(first.critic_status).toBe('UPHELD');
		expect(first.recorded_at).toBe(RECORDED_AT);
		expect(asRecord(findings[2]).severity).toBe('NONE');
		expect(fs.existsSync(artifactPath())).toBe(true);
	});

	test('AC2 consent boundary: export refuses an active gate and never touches the feedback surfaces', async () => {
		await prepareActiveWorkflow();
		const whileActive = await runExport();
		expect(whileActive.success).toBe(false);
		expect(whileActive.type).toBe('gate-active');
		await abortPrWorkflow(projectRoot, SESSION, {
			kind: 'recovery',
			reason: 'test abort',
		});
		const exported = await runExport();
		expect(exported.success).toBe(true);
		expect(fs.existsSync(path.join(runDir, 'feedback-consent.json'))).toBe(
			false,
		);
		expect(fs.existsSync(path.join(runDir, 'feedback-handoff.json'))).toBe(
			false,
		);
		expect(await readPrWorkflowGateState(projectRoot, SESSION)).toBe(null);
	});

	test('AC3 silence disclosure separates degraded, not-triggered, and reached boundaries', async () => {
		await prepareAbortedWorkflow();
		const artifact = await exportAndRead();
		const silence = asRecord(artifact.silence);
		const untested = asStringArray(silence.untested_families);
		expect(untested).toContain(DEGRADED_FAMILY);
		expect(untested).not.toContain(CLEAN_FAMILY);
		expect(asStringArray(silence.not_triggered_families)).toContain(
			NOT_TRIGGERED_FAMILY,
		);
		const boundaries = asStringArray(silence.boundaries_reached);
		expect(boundaries).toContain('post_explorer');
		expect(boundaries).toContain('post_reviewer');
		expect(asRecord(silence.base_coverage).status).toBe('unknown');
	});

	test('AC4 non-authoritative artifact marks the export partial with the disclosure banner', async () => {
		await prepareAbortedWorkflow();
		const artifact = await exportAndRead();
		expect(artifact.partial).toBe(true);
		expect(artifact.authoritative).toBe(false);
		expect(artifact.schema_version).toBe(1);
		const summary = artifact.summary;
		expect(typeof summary).toBe('string');
		expect(summary).toContain('PARTIAL');
		expect(summary).toContain('NON-AUTHORITATIVE');
		expect(summary).toContain('F-3097-1');
	});

	test('refusal: invalid-session when the caller context has no sessionID', async () => {
		await prepareAbortedWorkflow();
		const raw = await executeExportPrReviewPartialResults(
			{ run_id: RUN_ID, pr_head_sha: head },
			projectRoot,
			{},
		);
		const result = JSON.parse(raw) as ExportResult;
		expect(result.success).toBe(false);
		expect(result.type).toBe('invalid-session');
	});

	test('refusal: not-aborted when the events tail has no abort for the declared head', async () => {
		const foreignHead = 'c'.repeat(40);
		await prepareAbortedWorkflow({
			findingsHead: foreignHead,
			receiptHead: foreignHead,
		});
		const result = await runExport(foreignHead);
		expect(result.success).toBe(false);
		expect(result.type).toBe('not-aborted');
	});

	test('refusal: head-mismatch when a persisted findings row binds a different head', async () => {
		await prepareAbortedWorkflow({ findingsHead: 'd'.repeat(40) });
		const result = await runExport(head);
		expect(result.success).toBe(false);
		expect(result.type).toBe('head-mismatch');
	});

	test('refusal: receipt-missing when the trigger evaluation receipt is absent', async () => {
		await prepareAbortedWorkflow({ writeTriggerEval: false });
		const result = await runExport(head);
		expect(result.success).toBe(false);
		expect(result.type).toBe('receipt-missing');
	});

	test('refusal: reservation-mismatch when the run reservation names another session', async () => {
		await prepareAbortedWorkflow({
			reservationSession: 'sess-3097-other',
		});
		const result = await runExport(head);
		expect(result.success).toBe(false);
		expect(result.type).toBe('reservation-mismatch');
	});

	test('refusal: no-findings when the persisted findings file has zero rows', async () => {
		await prepareAbortedWorkflow({ findingsRowCount: 0 });
		const result = await runExport(head);
		expect(result.success).toBe(false);
		expect(result.type).toBe('no-findings');
	});

	test('re-export of the same aborted run is idempotent with a fresh exported_at', async () => {
		await prepareAbortedWorkflow();
		const first = await exportAndRead();
		const secondResult = await runExport();
		expect(secondResult.success).toBe(true);
		const second = readExportArtifact();
		expect(second.aborted_at).toBe(first.aborted_at);
		expect(
			typeof second.exported_at === 'string' &&
				typeof first.exported_at === 'string' &&
				(second.exported_at as string) >= (first.exported_at as string),
		).toBe(true);
		expect(fs.existsSync(artifactPath())).toBe(true);
	});
});
