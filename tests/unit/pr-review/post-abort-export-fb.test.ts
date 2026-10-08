/**
 * Issue #3097 feedback-round checks (swarm-pr-review run pr3140-20261008):
 * covers the export-tool behaviors the frozen post-abort-export.test.ts does
 * not — the fail-closed refusal arms (invalid-args, abort-scan-indeterminate,
 * invalid-findings, io-error, gate-indeterminate, artifact-too-large), the
 * reservation-ordering bound, the receipt schema_version dispatch (v1 rows,
 * unsupported versions, base_verification), coverage-disclosure states (v2 /
 * legacy v1 / foreign-bound / corrupt), the presumed-stale silence join hit
 * path, and the summary hardening (no submission header, no "dismissed"
 * wording, flattened interpolations, machine-readable truncation). The frozen
 * spec files are byte-locked by the issue-tracer checkpoint manifest, so all
 * feedback-round assertions live HERE; shared fixtures live in
 * post-abort-export-fb-fixtures.ts (FR-006 line cap applies to *.test.ts
 * files only).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { activatePrWorkflow } from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	executeExportPrReviewPartialResults,
} from '../../../src/tools/export-pr-review-partial-results.js';
import {
	appendEventLine,
	type ExportResult,
	findingRow,
	prepareAbortedWorkflow,
	RUN_ID,
	readArtifact,
	resetFbState,
	runExport,
	SESSION,
	SYNTHETIC_TS,
	state,
} from './post-abort-export-fb-fixtures.js';

function asRecord(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? (value as string[]) : [];
}

function readRealAbortTimestamp(): string {
	const eventsPath = path.join(state.projectRoot, '.swarm', 'events.jsonl');
	for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') continue;
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			if (
				parsed.type === 'pr_workflow_aborted' &&
				parsed.sessionID === SESSION &&
				parsed.prHeadSha === state.head
			) {
				return parsed.timestamp as string;
			}
		} catch {
			// Skip malformed lines; the durable abort line is well-formed JSON.
		}
	}
	throw new Error('fixture error: no real abort event found');
}

afterEach(() => {
	closeAllProjectDbs();
	if (state.projectRoot !== '') {
		try {
			fs.rmSync(state.projectRoot, { recursive: true, force: true });
		} catch {
			// Windows EBUSY teardown flake — the assertions already ran.
		}
	}
	resetFbState();
});

describe('post-abort export feedback round (pr3140-20261008)', () => {
	test('invalid-args rejects an abbreviated pr_head_sha at validation', async () => {
		await prepareAbortedWorkflow();
		const raw = await executeExportPrReviewPartialResults(
			{ run_id: RUN_ID, pr_head_sha: state.head.slice(0, 6) },
			state.projectRoot,
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
		appendEventLine(filler);
		const chunk = Array.from({ length: 17_999 }, () => filler).join('\n');
		appendEventLine(chunk);
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
		await activatePrWorkflow(state.projectRoot, SESSION, 'PR_REVIEW', {
			prHeadSha: state.head,
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
		const disclosurePath = path.join(state.runDir, 'coverage-disclosure.json');
		fs.writeFileSync(
			disclosurePath,
			JSON.stringify({
				schemaVersion: 2,
				runId: RUN_ID,
				prHeadSha: state.head,
				revisionDigest: 'digest',
				admittedAt: '2026-10-08T00:00:02.000Z',
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
				prHeadSha: state.head,
				revisionDigest: 'digest',
				admittedAt: '2026-10-08T00:00:02.000Z',
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
				prHeadSha: state.head,
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
		// Machine-readable truncation state accompanies the prose disclosure.
		const truncation = asRecord(artifact.summary_truncation);
		expect(truncation.body_truncated).toBe(false);
		expect(truncation.truncated_inline_comments).toBe(0);

		const reservationPath = path.join(state.runDir, 'run-reservation.json');
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

	test('recorded NONE severity joins the not-dismissed disclosure, never the renderer', async () => {
		await prepareAbortedWorkflow({ findingsRowCount: 1 });
		const findingsPath = path.join(state.runDir, 'findings.jsonl');
		const noneRow = findingRow(9, state.head);
		noneRow.severity = 'NONE';
		noneRow.status = 'DISPROVED';
		fs.appendFileSync(findingsPath, `${JSON.stringify(noneRow)}\n`);
		const result = await runExport();
		expect(result.success).toBe(true);
		const artifact = readArtifact();
		const summary = String(artifact.summary);
		expect(summary).not.toContain('dismissed) omitted');
		expect(summary).not.toContain('with no live severity');
		expect(summary).toContain('without a recorded severity');
		expect(summary).toContain('FB-9');
		const findings = asStringArray(artifact.findings);
		const noneArtifactRow = findings
			.map(asRecord)
			.find((row) => row.finding_id === 'FB-9');
		expect(noneArtifactRow).toBeDefined();
		expect(noneArtifactRow?.severity).toBe('NONE');
	});

	test('whitespace-padded live severity renders canonical, never dismissed', async () => {
		await prepareAbortedWorkflow({ findingsRowCount: 1 });
		const findingsPath = path.join(state.runDir, 'findings.jsonl');
		const padded = findingRow(7, state.head);
		padded.severity = ' High ';
		fs.appendFileSync(findingsPath, `${JSON.stringify(padded)}\n`);
		const result = await runExport();
		expect(result.success).toBe(true);
		const artifact = readArtifact();
		const summary = String(artifact.summary);
		expect(summary).not.toContain('dismissed) omitted');
		expect(summary).not.toContain('with no live severity');
		expect(summary).toContain('[FB-7]');
		expect(summary).toContain('### HIGH');
	});

	test('re-export re-reads the run sources rather than no-oping', async () => {
		await prepareAbortedWorkflow({ findingsRowCount: 1 });
		let result = await runExport();
		expect(result.success).toBe(true);
		expect(result.finding_count).toBe(1);
		const findingsPath = path.join(state.runDir, 'findings.jsonl');
		fs.appendFileSync(
			findingsPath,
			`${JSON.stringify(findingRow(2, state.head))}\n`,
		);
		result = await runExport();
		expect(result.success).toBe(true);
		expect(result.finding_count).toBe(2);
		const artifact = readArtifact();
		const findings = asStringArray(artifact.findings).map(asRecord);
		expect(findings.find((row) => row.finding_id === 'FB-2')).toBeDefined();
	});

	test('finding_count is distinct ids while record_count counts rows', async () => {
		await prepareAbortedWorkflow({ findingsRowCount: 2 });
		const findingsPath = path.join(state.runDir, 'findings.jsonl');
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
				prHeadSha: state.head,
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

	test('gate-indeterminate when the gate reader throws', async () => {
		await prepareAbortedWorkflow();
		// The durable reader is salvage-tolerant by design, so the throw path is
		// exercised through the module's own DI seam (no mock.module).
		const original = _internals.readGateState;
		_internals.readGateState = async () => {
			throw new Error('simulated unreadable gate authority');
		};
		try {
			const result = await runExport();
			expect(result.success).toBe(false);
			expect(result.type).toBe('gate-indeterminate');
		} finally {
			_internals.readGateState = original;
		}
	});

	test('artifact-too-large when the serialized export exceeds the cap', async () => {
		await prepareAbortedWorkflow();
		// Unknown fields are retained verbatim (F-009 passthrough), so nested
		// padding survives to the pretty-printed artifact: the 2-space indent
		// re-expands a compact ≤10 MiB findings.jsonl past the +24 MiB margin.
		const chain = (): Record<string, unknown> => {
			let node: Record<string, unknown> = {};
			for (let depth = 0; depth < 25; depth += 1) {
				node = { a: node };
			}
			return node;
		};
		const paddingRow = findingRow(50, state.head);
		paddingRow.fb_padding = Array.from({ length: 30_000 }, () => chain());
		const findingsPath = path.join(state.runDir, 'findings.jsonl');
		fs.writeFileSync(findingsPath, `${JSON.stringify(paddingRow)}\n`);
		const stat = fs.statSync(findingsPath);
		expect(stat.size).toBeLessThanOrEqual(10 * 1024 * 1024);
		const result = await runExport();
		expect(result.success).toBe(false);
		expect(result.type).toBe('artifact-too-large');
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
