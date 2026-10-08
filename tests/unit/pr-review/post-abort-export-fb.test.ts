/**
 * Issue #3097 feedback-round checks (swarm-pr-review run pr3140-20261008):
 * covers the export-tool behaviors the frozen post-abort-export.test.ts does
 * not — the fail-closed refusal arms (invalid-args, abort-scan-indeterminate,
 * invalid-findings, io-error), the reservation-ordering bound, the receipt
 * schema_version dispatch (v1 rows, unsupported versions, base_verification),
 * coverage-disclosure states (v2 / legacy v1 / foreign-bound / corrupt), the
 * presumed-stale silence join hit path, the summary hardening (no submission
 * header, no "dismissed" wording, flattened interpolations), and the success
 * envelope fields. The frozen spec files are byte-locked by the issue-tracer
 * checkpoint manifest, so all feedback-round assertions live HERE.
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
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	executeExportPrReviewPartialResults,
} from '../../../src/tools/export-pr-review-partial-results.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

const SESSION = 'sess-3097-fb';
const RUN_ID = 'run-3097-fb';
const BASE_SHA = 'b'.repeat(40);
const RESERVED_AT = '2026-10-08T00:00:01.000Z';
const EVALUATED_AT = '2026-10-08T00:00:02.000Z';
const RECORDED_AT = '2026-10-08T00:00:03.000Z';
const SYNTHETIC_TS = '2099-01-01T00:00:00.000Z';
const GIT_TIMEOUT_MS = 30_000;

let projectRoot = '';
let head = '';
let runDir = '';

interface ExportResult {
	success?: boolean;
	type?: string;
	message?: string;
	path?: string;
	finding_count?: number;
	record_count?: number;
	untested_family_count?: number;
	partial?: boolean;
	authoritative?: boolean;
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
	const rows = PR_REVIEW_TRIGGER_DEFINITIONS.map((definition) => ({
		trigger_id: definition.id,
		result: 'MATCHED' as const,
		evidence: `fb fixture: ${definition.id} matched`,
		source_batch_id: 'batch-3097-fb',
		source_lane_id: `lane-${definition.id}`,
	}));
	return buildPrReviewTriggerReceiptV2({
		run_id: RUN_ID,
		pr_head_sha: prHead,
		base_ref: 'main',
		base_sha: BASE_SHA,
		evaluated_at: EVALUATED_AT,
		dispatched_micro_lane_count: 11,
		rows,
		coverage_degradations: [],
	});
}

function findingRow(index: number, prHead: string): Record<string, unknown> {
	const row: Record<string, unknown> = {
		finding_id: `FB-${index}`,
		status: 'CONFIRMED',
		file_line: `src/fb.ts:${10 * index}`,
		evidence: `fb fixture finding ${index}`,
		next_action: 'report',
		boundary: 'post_explorer',
		pr_head_sha: prHead,
		recorded_at: RECORDED_AT,
	};
	if (index % 2 === 1) {
		row.severity = 'MEDIUM';
		row.risk_impact = 'UNKNOWN';
		row.risk_tags = [];
	}
	return row;
}

interface SeedOptions {
	reservedAt?: string;
	receiptMode?: 'v2' | 'v1' | 'version3' | 'boundFallback' | 'absent';
	findingsMode?: 'normal' | 'malformed';
	findingsRowCount?: number;
}

function seedRunArtifacts(options: SeedOptions): void {
	runDir = path.join(projectRoot, '.swarm', 'pr-review', RUN_ID);
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(
		path.join(runDir, 'run-reservation.json'),
		JSON.stringify({
			schema_version: 1,
			session_id: SESSION,
			workflow_instance_id: 'wf-3097-fb',
			run_id: RUN_ID,
			reserved_at: options.reservedAt ?? RESERVED_AT,
		}),
	);
	const receiptMode = options.receiptMode ?? 'v2';
	if (receiptMode !== 'absent') {
		let receipt: Record<string, unknown>;
		if (receiptMode === 'v1') {
			receipt = {
				schema_version: 1,
				run_id: RUN_ID,
				pr_head_sha: head,
				base_ref: 'main',
				base_sha: BASE_SHA,
				evaluated_at: EVALUATED_AT,
				dispatched_micro_lane_count: 2,
				rows: [
					{
						trigger_id: 'subprocess-platform',
						result: 'MATCHED',
						evidence: 'fb v1 receipt row',
						source_batch_id: 'batch-fb-v1',
						source_lane_id: 'lane-subprocess-platform',
					},
				],
			};
		} else {
			receipt = asRecord(buildReceipt(head));
			if (receiptMode === 'version3') receipt.schema_version = 3;
			if (receiptMode === 'boundFallback') {
				receipt.base_verification = 'bound_fallback';
			}
		}
		fs.writeFileSync(
			path.join(runDir, 'trigger-eval.json'),
			`${JSON.stringify(receipt, null, 2)}\n`,
		);
	}
	const count = options.findingsRowCount ?? 2;
	const lines: string[] = [];
	for (let index = 1; index <= count; index += 1) {
		lines.push(JSON.stringify(findingRow(index, head)));
	}
	if (options.findingsMode === 'malformed') lines.push('not-json-at-all');
	fs.writeFileSync(
		path.join(runDir, 'findings.jsonl'),
		lines.length > 0 ? `${lines.join('\n')}\n` : '',
	);
}

async function prepareAbortedWorkflow(
	options: SeedOptions = {},
): Promise<void> {
	projectRoot = canonicalMkdtemp('post-abort-export-fb-');
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
	await activatePrWorkflow(projectRoot, SESSION, 'PR_REVIEW', {
		prHeadSha: head,
	});
	seedRunArtifacts(options);
	await abortPrWorkflow(projectRoot, SESSION, {
		kind: 'recovery',
		reason: 'fb test abort',
	});
}

async function runExport(prHead: string = head): Promise<ExportResult> {
	const raw = await executeExportPrReviewPartialResults(
		{ run_id: RUN_ID, pr_head_sha: prHead },
		projectRoot,
		{ sessionID: SESSION },
	);
	return JSON.parse(raw) as ExportResult;
}

function readArtifact(): Record<string, unknown> {
	return JSON.parse(
		fs.readFileSync(path.join(runDir, 'post-abort-export.json'), 'utf8'),
	) as Record<string, unknown>;
}

function appendEventLine(line: string): void {
	const eventsPath = path.join(projectRoot, '.swarm', 'events.jsonl');
	fs.appendFileSync(eventsPath, `${line}\n`);
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
});

describe('post-abort export feedback round (pr3140-20261008)', () => {
	test('invalid-args rejects an abbreviated pr_head_sha at validation', async () => {
		await prepareAbortedWorkflow();
		const raw = await executeExportPrReviewPartialResults(
			{ run_id: RUN_ID, pr_head_sha: head.slice(0, 6) },
			projectRoot,
			{ sessionID: SESSION },
		);
		const result = JSON.parse(raw) as ExportResult;
		expect(result.success).toBe(false);
		expect(result.type).toBe('invalid-args');
	});

	test('invalid-findings on a findings.jsonl line that is not JSON', async () => {
		await prepareAbortedWorkflow({ findingsMode: 'malformed' });
		const result = await runExport();
		expect(result.success).toBe(false);
		expect(result.type).toBe('invalid-findings');
	});

	test('io-error when the artifact write fails', async () => {
		await prepareAbortedWorkflow();
		const original = _internals.atomicWrite;
		_internals.atomicWrite = async () => {
			throw new Error('simulated write failure');
		};
		try {
			const result = await runExport();
			expect(result.success).toBe(false);
			expect(result.type).toBe('io-error');
			expect(result.message).not.toContain('C:');
		} finally {
			_internals.atomicWrite = original;
		}
	});

	test('abort-scan-indeterminate when the events file exceeds the read bound', async () => {
		await prepareAbortedWorkflow();
		const filler = JSON.stringify({
			type: 'filler',
			timestamp: '2026-10-08T00:00:00.000Z',
			payload: 'x'.repeat(180),
		});
		const eventsPath = path.join(projectRoot, '.swarm', 'events.jsonl');
		const chunk = `${filler}\n`.repeat(18_000);
		fs.appendFileSync(eventsPath, chunk);
		const result = await runExport();
		expect(result.success).toBe(false);
		expect(result.type).toBe('abort-scan-indeterminate');
	});

	test('not-aborted when the abort predates the run reservation (ordering bound)', async () => {
		await prepareAbortedWorkflow({ reservedAt: '2099-01-02T00:00:00.000Z' });
		const result = await runExport();
		expect(result.success).toBe(false);
		expect(result.type).toBe('not-aborted');
		expect(result.message).toContain('predates');
	});

	test('gate-active when a gate is re-activated before the export', async () => {
		await prepareAbortedWorkflow();
		await activatePrWorkflow(projectRoot, SESSION, 'PR_REVIEW', {
			prHeadSha: head,
		});
		const result = await runExport();
		expect(result.success).toBe(false);
		expect(result.type).toBe('gate-active');
	});

	test('receipt-unsupported on an unknown trigger receipt schema_version', async () => {
		await prepareAbortedWorkflow({ receiptMode: 'version3' });
		const result = await runExport();
		expect(result.success).toBe(false);
		expect(result.type).toBe('receipt-unsupported');
	});

	test('v1 receipt: silence joins MATCHED-only rows and absent families go untested', async () => {
		await prepareAbortedWorkflow({ receiptMode: 'v1' });
		const result = await runExport();
		expect(result.success).toBe(true);
		const artifact = readArtifact();
		const silence = asRecord(artifact.silence);
		expect(silence.families_source).toBe('v1-receipt-rows');
		const untested = asStringArray(silence.untested_families);
		expect(untested).toContain('auth-identity-secrets');
		expect(untested).not.toContain('subprocess-platform');
		expect(asStringArray(silence.not_triggered_families)).toEqual([]);
	});

	test('bound_fallback base verification is forwarded to provenance and summary', async () => {
		await prepareAbortedWorkflow({ receiptMode: 'boundFallback' });
		const result = await runExport();
		expect(result.success).toBe(true);
		const artifact = readArtifact();
		const provenance = asRecord(artifact.provenance);
		expect(provenance.base_verification).toBe('bound_fallback');
		const summary = artifact.summary;
		expect(summary).toContain('bound fallback');
	});

	test('coverage-disclosure present: v2 dimensions, legacy missingDimension, foreign, corrupt', async () => {
		await prepareAbortedWorkflow();
		const disclosurePath = path.join(runDir, 'coverage-disclosure.json');
		fs.writeFileSync(
			disclosurePath,
			JSON.stringify({
				schemaVersion: 2,
				runId: RUN_ID,
				prHeadSha: head,
				revisionDigest: 'digest',
				admittedAt: EVALUATED_AT,
				unresolvedDimensions: [
					{
						dimension: 'api-schema-migrations',
						terminalState: 'FAILED',
						reasonKind: 'lane_failure',
					},
				],
			}),
		);
		let result = await runExport();
		expect(result.success).toBe(true);
		let artifact = readArtifact();
		let silence = asRecord(artifact.silence);
		let baseCoverage = asRecord(silence.base_coverage);
		expect(baseCoverage.status).toBe('unresolved');
		expect(asStringArray(baseCoverage.unresolved_dimensions)).toEqual([
			'api-schema-migrations',
		]);
		expect(artifact.summary).toContain('PARTIAL (post-abort)');

		fs.writeFileSync(
			disclosurePath,
			JSON.stringify({
				schemaVersion: 1,
				runId: RUN_ID,
				prHeadSha: head,
				revisionDigest: 'digest',
				admittedAt: EVALUATED_AT,
				missingDimension: 'auth-identity-secrets',
			}),
		);
		result = await runExport();
		artifact = readArtifact();
		silence = asRecord(artifact.silence);
		baseCoverage = asRecord(silence.base_coverage);
		expect(baseCoverage.status).toBe('unresolved');
		expect(asStringArray(baseCoverage.unresolved_dimensions)).toEqual([
			'auth-identity-secrets',
		]);

		fs.writeFileSync(
			disclosurePath,
			JSON.stringify({
				schemaVersion: 2,
				runId: 'run-other',
				prHeadSha: head,
				unresolvedDimensions: [],
			}),
		);
		result = await runExport();
		artifact = readArtifact();
		silence = asRecord(artifact.silence);
		baseCoverage = asRecord(silence.base_coverage);
		expect(baseCoverage.status).toBe('unreadable');
		expect(String(baseCoverage.note)).toContain('different run or head');

		fs.writeFileSync(disclosurePath, 'not-json');
		result = await runExport();
		artifact = readArtifact();
		silence = asRecord(artifact.silence);
		baseCoverage = asRecord(silence.base_coverage);
		expect(baseCoverage.status).toBe('unreadable');
	});

	test('summary hardening: no submission header, severity-less rows named not dismissed, newline flattened', async () => {
		await prepareAbortedWorkflow({ findingsRowCount: 2 });
		const result = await runExport();
		expect(result.success).toBe(true);
		const artifact = readArtifact();
		const summary = String(artifact.summary);
		expect(summary).not.toContain('PR review submission for run');
		expect(summary).toContain('Post-abort partial-results export for run');
		// The renderer's own dismissal line must never appear; the export's
		// negation ("NOT dismissed") is the only allowed occurrence.
		expect(summary).not.toContain('dismissed) omitted');
		expect(summary).not.toContain('with no live severity');
		expect(summary).toContain('without a recorded severity');
		expect(summary).toContain('FB-2');

		const reservationPath = path.join(runDir, 'run-reservation.json');
		const reservation = asRecord(
			JSON.parse(fs.readFileSync(reservationPath, 'utf8')),
		);
		reservation.workflow_instance_id = 'wf\n\n## Injected section';
		fs.writeFileSync(reservationPath, JSON.stringify(reservation));
		await runExport();
		const hardened = readArtifact();
		const hardenedSummary = String(hardened.summary);
		expect(hardenedSummary).not.toContain('wf\n');
	});

	test('finding_count is distinct ids while record_count counts rows', async () => {
		await prepareAbortedWorkflow({ findingsRowCount: 2 });
		const findingsPath = path.join(runDir, 'findings.jsonl');
		const duplicate = asRecord(
			JSON.parse(fs.readFileSync(findingsPath, 'utf8').split('\n')[0]),
		);
		duplicate.boundary = 'post_critic';
		fs.appendFileSync(findingsPath, `${JSON.stringify(duplicate)}\n`);
		const result = await runExport();
		expect(result.success).toBe(true);
		expect(result.finding_count).toBe(2);
		expect(result.record_count).toBe(3);
	});

	test('success envelope carries path, counts, and the partial markers', async () => {
		await prepareAbortedWorkflow();
		const result = await runExport();
		expect(result.success).toBe(true);
		expect(result.path).toBe(`pr-review/${RUN_ID}/post-abort-export.json`);
		expect(result.finding_count).toBe(2);
		expect(result.record_count).toBe(2);
		expect(result.untested_family_count).toBe(0);
		expect(result.partial).toBe(true);
		expect(result.authoritative).toBe(false);
	});

	test('presumed-stale join marks the cited family untested and binds aborted_at', async () => {
		await prepareAbortedWorkflow();
		appendEventLine(
			JSON.stringify({
				type: 'pr_workflow_aborted',
				timestamp: SYNTHETIC_TS,
				sessionID: SESSION,
				mode: 'PR_REVIEW',
				kind: 'recovery',
				prHeadSha: head,
				openLanes: 2,
				presumedStaleLanes: ['lane-auth-identity-secrets'],
				reason: 'fb synthetic presumed-stale event',
			}),
		);
		const result = await runExport();
		expect(result.success).toBe(true);
		const artifact = readArtifact();
		expect(artifact.aborted_at).toBe(SYNTHETIC_TS);
		const silence = asRecord(artifact.silence);
		expect(asStringArray(silence.untested_families)).toContain(
			'auth-identity-secrets',
		);
		const laneState = asRecord(artifact.abort_lane_state);
		expect(laneState.open_lanes).toBe(2);
	});

	test('a newer foreign-head abort event does not hijack aborted_at', async () => {
		await prepareAbortedWorkflow();
		const realTimestamp = readRealAbortTimestamp();
		appendEventLine(
			JSON.stringify({
				type: 'pr_workflow_aborted',
				timestamp: SYNTHETIC_TS,
				sessionID: SESSION,
				mode: 'PR_REVIEW',
				kind: 'recovery',
				prHeadSha: 'c'.repeat(40),
				openLanes: 9,
				reason: 'fb foreign-head event',
			}),
		);
		const result = await runExport();
		expect(result.success).toBe(true);
		const artifact = readArtifact();
		expect(artifact.aborted_at).toBe(realTimestamp);
	});

	test('rider anchor: the abort reason schema enforces the documented 500-char cap', async () => {
		const { abort_pr_workflow } = await import(
			'../../../src/tools/abort-pr-workflow.js'
		);
		const args = abort_pr_workflow.args as Record<
			string,
			{ safeParse(value: unknown): { success: boolean } }
		>;
		const reasonSchema = args.reason;
		expect(reasonSchema.safeParse('r'.repeat(500)).success).toBe(true);
		expect(reasonSchema.safeParse('r'.repeat(501)).success).toBe(false);
	});
});

function readRealAbortTimestamp(): string {
	const eventsPath = path.join(projectRoot, '.swarm', 'events.jsonl');
	for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') continue;
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			if (
				parsed.type === 'pr_workflow_aborted' &&
				parsed.sessionID === SESSION &&
				parsed.prHeadSha === head
			) {
				return parsed.timestamp as string;
			}
		} catch {
			// Skip malformed lines; the durable abort line is well-formed JSON.
		}
	}
	throw new Error('fixture error: no real abort event found');
}
