/**
 * Shared fixtures for the #3097 feedback-round export checks
 * (post-abort-export-fb.test.ts). Non-test module: the FR-006 line cap
 * applies to *.test.ts files only, so fixture growth lands here.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildPrReviewTriggerReceiptV2,
	PR_REVIEW_TRIGGER_DEFINITIONS,
} from '../../../src/background/pr-review-trigger-contract.js';
import {
	abortPrWorkflow,
	activatePrWorkflow,
} from '../../../src/hooks/pr-workflow-gate.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

export const SESSION = 'sess-3097-fb';
export const RUN_ID = 'run-3097-fb';
export const BASE_SHA = 'b'.repeat(40);
export const RESERVED_AT = '2026-10-08T00:00:01.000Z';
export const EVALUATED_AT = '2026-10-08T00:00:02.000Z';
export const RECORDED_AT = '2026-10-08T00:00:03.000Z';
export const SYNTHETIC_TS = '2099-01-01T00:00:00.000Z';
const GIT_TIMEOUT_MS = 30_000;

/** Mutable fixture state, rebuilt by prepareAbortedWorkflow each test. */
export const state = {
	projectRoot: '',
	head: '',
	runDir: '',
};

export function resetFbState(): void {
	state.projectRoot = '';
	state.head = '';
	state.runDir = '';
}

export interface ExportResult {
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

export interface SeedOptions {
	reservedAt?: string;
	receiptMode?: 'v2' | 'v1' | 'version3' | 'boundFallback' | 'absent';
	findingsMode?: 'normal' | 'malformed';
	findingsRowCount?: number;
}

export function git(args: string[]): string {
	return execFileSync('git', ['-C', state.projectRoot, ...args], {
		encoding: 'utf8',
		timeout: GIT_TIMEOUT_MS,
	}).trim();
}

export function buildReceipt(prHead: string): unknown {
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

export function findingRow(
	index: number,
	prHead: string,
): Record<string, unknown> {
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

export function seedRunArtifacts(options: SeedOptions): void {
	state.runDir = path.join(state.projectRoot, '.swarm', 'pr-review', RUN_ID);
	fs.mkdirSync(state.runDir, { recursive: true });
	fs.writeFileSync(
		path.join(state.runDir, 'run-reservation.json'),
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
				pr_head_sha: state.head,
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
			receipt = buildReceipt(state.head) as Record<string, unknown>;
			if (receiptMode === 'version3') receipt.schema_version = 3;
			if (receiptMode === 'boundFallback') {
				receipt.base_verification = 'bound_fallback';
			}
		}
		fs.writeFileSync(
			path.join(state.runDir, 'trigger-eval.json'),
			`${JSON.stringify(receipt, null, 2)}\n`,
		);
	}
	const count = options.findingsRowCount ?? 2;
	const lines: string[] = [];
	for (let index = 1; index <= count; index += 1) {
		lines.push(JSON.stringify(findingRow(index, state.head)));
	}
	if (options.findingsMode === 'malformed') lines.push('not-json-at-all');
	fs.writeFileSync(
		path.join(state.runDir, 'findings.jsonl'),
		lines.length > 0 ? `${lines.join('\n')}\n` : '',
	);
}

export async function prepareAbortedWorkflow(
	options: SeedOptions = {},
): Promise<void> {
	state.projectRoot = canonicalMkdtemp('post-abort-export-fb-');
	await initializeGitRepository(state.projectRoot);
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
	state.head = git(['rev-parse', 'HEAD']);
	await activatePrWorkflow(state.projectRoot, SESSION, 'PR_REVIEW', {
		prHeadSha: state.head,
	});
	seedRunArtifacts(options);
	await abortPrWorkflow(state.projectRoot, SESSION, {
		kind: 'recovery',
		reason: 'fb test abort',
	});
}

export async function runExport(
	prHead: string = state.head,
): Promise<ExportResult> {
	const { executeExportPrReviewPartialResults } = await import(
		'../../../src/tools/export-pr-review-partial-results.js'
	);
	const raw = await executeExportPrReviewPartialResults(
		{ run_id: RUN_ID, pr_head_sha: prHead },
		state.projectRoot,
		{ sessionID: SESSION },
	);
	return JSON.parse(raw) as ExportResult;
}

export function readArtifact(): Record<string, unknown> {
	return JSON.parse(
		fs.readFileSync(path.join(state.runDir, 'post-abort-export.json'), 'utf8'),
	) as Record<string, unknown>;
}

export function appendEventLine(line: string): void {
	const eventsPath = path.join(state.projectRoot, '.swarm', 'events.jsonl');
	fs.appendFileSync(eventsPath, `${line}\n`);
}
