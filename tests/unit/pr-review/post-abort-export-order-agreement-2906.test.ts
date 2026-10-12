// Issue #2906 (review F-06) — post-abort export passthrough for the
// per-finding `order_agreement` label. Two independent mechanisms must both
// survive the export path in src/tools/export-pr-review-partial-results.ts:
// - the RAW field lands in the exported JSON `findings` array (retained only
//   through `readFindingsRows`' forward-compatible unknown-field loop — the
//   known-field constructor never copies it);
// - the label reaches the renderer (`rendererFindings` passes it through), so
//   a 'disagree' row renders the '(order-unstable)' marker and the unstable
//   count line in the summary.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	abortPrWorkflow,
	activatePrWorkflow,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeExportPrReviewPartialResults } from '../../../src/tools/export-pr-review-partial-results.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

const SESSION = 'sess-2906-f06';
const RUN_ID = 'run-2906-f06';
const RESERVED_AT = '2026-10-08T00:00:01.000Z';
const RECORDED_AT = '2026-10-08T00:00:03.000Z';
const GIT_TIMEOUT_MS = 30_000;

let projectRoot = '';
let head = '';
let runDir = '';

function git(args: string[]): string {
	return execFileSync('git', ['-C', projectRoot, ...args], {
		encoding: 'utf8',
		timeout: GIT_TIMEOUT_MS,
	}).trim();
}

interface FindingRow {
	finding_id: string;
	status: 'CONFIRMED';
	file_line: string;
	evidence: string;
	next_action: 'report';
	severity: 'MEDIUM' | 'HIGH';
	risk_impact: 'UNKNOWN';
	risk_tags: [];
	order_agreement: 'disagree' | 'agree';
	boundary: 'post_reviewer';
	pr_head_sha: string;
	recorded_at: string;
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

describe('post-abort export order_agreement passthrough (#2906 F-06)', () => {
	test('the raw label survives into the exported JSON and renders the marker', async () => {
		projectRoot = canonicalMkdtemp('post-abort-export-oa-');
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
		const workflowInstanceId =
			typeof state.workflowInstanceId === 'string' &&
			state.workflowInstanceId.length > 0
				? state.workflowInstanceId
				: 'unknown';
		runDir = path.join(projectRoot, '.swarm', 'pr-review', RUN_ID);
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(
			path.join(runDir, 'run-reservation.json'),
			JSON.stringify({
				schema_version: 1,
				session_id: SESSION,
				workflow_instance_id: workflowInstanceId,
				run_id: RUN_ID,
				reserved_at: RESERVED_AT,
			}),
		);
		fs.writeFileSync(
			path.join(runDir, 'trigger-eval.json'),
			JSON.stringify({
				schema_version: 1,
				run_id: RUN_ID,
				pr_head_sha: head,
				base_ref: 'main',
				base_sha: 'b'.repeat(40),
				evaluated_at: '2026-10-08T00:00:02.000Z',
				rows: [
					{
						trigger_id: 'subprocess-platform',
						result: 'MATCHED',
						evidence: 'fixture evidence',
						source_batch_id: 'batch-f06',
						source_lane_id: 'lane-f06',
					},
				],
			}),
		);
		const rows: FindingRow[] = [
			{
				finding_id: 'F-2906-1',
				status: 'CONFIRMED',
				file_line: 'src/example.ts:10',
				evidence: 'order-unstable fixture finding',
				next_action: 'report',
				severity: 'MEDIUM',
				risk_impact: 'UNKNOWN',
				risk_tags: [],
				order_agreement: 'disagree',
				boundary: 'post_reviewer',
				pr_head_sha: head,
				recorded_at: RECORDED_AT,
			},
			{
				finding_id: 'F-2906-2',
				status: 'CONFIRMED',
				file_line: 'src/example.ts:20',
				evidence: 'order-stable fixture finding',
				next_action: 'report',
				severity: 'HIGH',
				risk_impact: 'UNKNOWN',
				risk_tags: [],
				order_agreement: 'agree',
				boundary: 'post_reviewer',
				pr_head_sha: head,
				recorded_at: RECORDED_AT,
			},
		];
		fs.writeFileSync(
			path.join(runDir, 'findings.jsonl'),
			`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
		);
		await abortPrWorkflow(projectRoot, SESSION, {
			kind: 'recovery',
			reason: 'test abort',
		});

		const raw = await executeExportPrReviewPartialResults(
			{ run_id: RUN_ID, pr_head_sha: head },
			projectRoot,
			{ sessionID: SESSION },
		);
		const result = JSON.parse(raw) as { success?: boolean };
		expect(result.success).toBe(true);
		const artifact = JSON.parse(
			fs.readFileSync(path.join(runDir, 'post-abort-export.json'), 'utf8'),
		) as { findings?: Array<Record<string, unknown>>; summary?: string };
		// Raw-field survival in the exported JSON.
		const findings = artifact.findings ?? [];
		expect(findings).toHaveLength(2);
		expect(findings[0]?.order_agreement).toBe('disagree');
		expect(findings[1]?.order_agreement).toBe('agree');
		// Renderer consumption: only the disagree row renders the marker, and
		// the count line stays at exactly one unstable finding.
		const summary = artifact.summary ?? '';
		expect(summary).toContain('F-2906-1] (order-unstable)');
		expect(summary).not.toContain('F-2906-2] (order-unstable)');
		expect(summary).toContain('1 finding(s) order-unstable');
	});
});
