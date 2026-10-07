import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	executePrReviewSubmission,
	_internals as submissionInternals,
} from '../../../src/tools/pr-review-submission.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const RUN_ID = 'tool-round2-run';
const REPO_SLUG = 'example/example-repo';
const PR_NUMBER = 910;

interface ExternalToolCall {
	executable: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	maxStdoutBytes: number;
	maxStderrBytes: number;
}

interface ExternalToolRunResult {
	status: 'completed' | 'timeout' | 'cancelled' | 'spawn-error';
	exitCode: number | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
}

let directory = '';
let calls: ExternalToolCall[];
const originalResolveGhBinary = submissionInternals.resolveGhBinary;
const originalRunExternalTool = submissionInternals.runExternalTool;

function record(
	id: string,
	severity: string,
	fileLine: string,
): Record<string, unknown> {
	return {
		finding_id: id,
		status: 'CONFIRMED',
		file_line: fileLine,
		evidence: `settled evidence for ${id}`,
		next_action: 'report',
		severity,
		boundary: 'post_critic',
		pr_head_sha: PR_ARTIFACT_HEAD_SHA,
		recorded_at: '2026-10-06T01:00:00.000Z',
	};
}

async function seedRun(
	root: string,
	records: Record<string, unknown>[],
): Promise<void> {
	const runDir = join(root, '.swarm', 'pr-review', RUN_ID);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(
		join(runDir, 'trigger-eval.json'),
		JSON.stringify({
			run_id: RUN_ID,
			pr_head_sha: PR_ARTIFACT_HEAD_SHA,
		}),
		'utf-8',
	);
	await fs.writeFile(
		join(runDir, 'findings.jsonl'),
		records.map((item) => JSON.stringify(item)).join('\n'),
		'utf-8',
	);
}

function validArgs(): Record<string, unknown> {
	return {
		pr_head_sha: PR_ARTIFACT_HEAD_SHA,
		pr_number: PR_NUMBER,
		repo: REPO_SLUG,
		run_id: RUN_ID,
	};
}

async function execute(args: unknown): Promise<string> {
	return executePrReviewSubmission(args, directory, {
		sessionID: PR_ARTIFACT_SESSION_ID,
	});
}

function defaultRunResult(call: ExternalToolCall): ExternalToolRunResult {
	const isGet = !call.args.includes('POST');
	if (isGet) {
		return {
			status: 'completed',
			exitCode: 0,
			stdout: '[]',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		};
	}
	return {
		status: 'completed',
		exitCode: 0,
		stdout: '{"id":8,"html_url":"https://example.com/review/8"}',
		stderr: '',
		stdoutTruncated: false,
		stderrTruncated: false,
	};
}

async function readPayload(
	call: ExternalToolCall,
): Promise<Record<string, unknown>> {
	const inputIndex = call.args.indexOf('--input');
	expect(inputIndex).toBeGreaterThan(-1);
	const raw = await fs.readFile(call.args[inputIndex + 1], 'utf-8');
	return JSON.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
	directory = canonicalMkdtemp('pr-review-submission-round2-');
	calls = [];
	submissionInternals.resolveGhBinary = () => '/fake/gh';
	submissionInternals.runExternalTool = async (options) => {
		calls.push(options);
		return defaultRunResult(options);
	};
});

afterEach(async () => {
	submissionInternals.resolveGhBinary = originalResolveGhBinary;
	submissionInternals.runExternalTool = originalRunExternalTool;
	closeAllProjectDbs();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('pr_review_submission feedback round 2 (reviewer-required arms)', () => {
	test('receipt evaluated_at anchors settlementTime (FB-010/tc-2)', async () => {
		// recorded_at 01:00 < evaluated_at 02:00, so settlement is 02:00 only
		// when the evaluated_at term participates; an abort at 01:30 sits
		// between the two and must NOT block. With the evaluated_at branch
		// deleted, settlement would be 01:00, the 01:30 abort would block,
		// and this test would go red.
		await seedRun(directory, [record('EV-1', 'LOW', 'src/ev1.ts:1')]);
		const runDir = join(directory, '.swarm', 'pr-review', RUN_ID);
		await fs.writeFile(
			join(runDir, 'trigger-eval.json'),
			JSON.stringify({
				run_id: RUN_ID,
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				evaluated_at: '2026-10-06T02:00:00.000Z',
			}),
			'utf-8',
		);
		await fs.mkdir(join(directory, '.swarm'), { recursive: true });
		await fs.writeFile(
			join(directory, '.swarm', 'events.jsonl'),
			`${JSON.stringify({
				type: 'pr_workflow_aborted',
				timestamp: '2026-10-06T01:30:00.000Z',
				sessionID: PR_ARTIFACT_SESSION_ID,
				mode: 'PR_REVIEW',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
			})}\n`,
			'utf-8',
		);
		const raw = await execute(validArgs());
		expect(JSON.parse(raw).success).toBe(true);
	});

	test('an abort at or after evaluated_at still blocks (FB-010/tc-2 negative)', async () => {
		await seedRun(directory, [record('EV-2', 'LOW', 'src/ev2.ts:1')]);
		const runDir = join(directory, '.swarm', 'pr-review', RUN_ID);
		await fs.writeFile(
			join(runDir, 'trigger-eval.json'),
			JSON.stringify({
				run_id: RUN_ID,
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				evaluated_at: '2026-10-06T02:00:00.000Z',
			}),
			'utf-8',
		);
		await fs.mkdir(join(directory, '.swarm'), { recursive: true });
		await fs.writeFile(
			join(directory, '.swarm', 'events.jsonl'),
			`${JSON.stringify({
				type: 'pr_workflow_aborted',
				timestamp: '2026-10-06T02:30:00.000Z',
				sessionID: PR_ARTIFACT_SESSION_ID,
				mode: 'PR_REVIEW',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
			})}\n`,
			'utf-8',
		);
		const raw = await execute(validArgs());
		const parsed = JSON.parse(raw) as { success: boolean; type: string };
		expect(parsed.success).toBe(false);
		expect(parsed.type).toBe('aborted');
		expect(calls.filter((call) => call.args.includes('POST'))).toHaveLength(0);
	});

	test('a pattern-passing traversal run_id refuses invalid-args (PRR-015 probe)', async () => {
		// 'a..' passes RUN_ID_PATTERN but throws inside validateSwarmPath —
		// safePath must convert that into a typed refusal, not an
		// execution_error envelope, and no transport call may fire.
		await seedRun(directory, [record('PR-1', 'LOW', 'src/pr1.ts:1')]);
		const raw = await execute({ ...validArgs(), run_id: 'a..' });
		const parsed = JSON.parse(raw) as { success: boolean; type: string };
		expect(parsed.success).toBe(false);
		expect(parsed.type).toBe('invalid-args');
		expect(calls).toHaveLength(0);
	});

	test('mixed valid + corrupt findings.jsonl refuses not-settled (no partial publish)', async () => {
		await seedRun(directory, [record('MX-1', 'LOW', 'src/mx1.ts:1')]);
		const runDir = join(directory, '.swarm', 'pr-review', RUN_ID);
		await fs.writeFile(
			join(runDir, 'findings.jsonl'),
			`${JSON.stringify(record('MX-2', 'LOW', 'src/mx2.ts:2'))}\n{"finding_id": "BROKEN"`,
			'utf-8',
		);
		const raw = await execute(validArgs());
		const parsed = JSON.parse(raw) as { success: boolean; type: string };
		expect(parsed.success).toBe(false);
		expect(parsed.type).toBe('not-settled');
		expect(calls.filter((call) => call.args.includes('POST'))).toHaveLength(0);
	});

	test('corrupt findings.jsonl refuses not-settled (FB-010/md-4)', async () => {
		await seedRun(directory, [record('CJ-1', 'LOW', 'src/cj1.ts:1')]);
		const runDir = join(directory, '.swarm', 'pr-review', RUN_ID);
		await fs.writeFile(
			join(runDir, 'findings.jsonl'),
			'{"finding_id": "BROKEN"',
			'utf-8',
		);
		const raw = await execute(validArgs());
		const parsed = JSON.parse(raw) as { success: boolean; type: string };
		expect(parsed.success).toBe(false);
		expect(parsed.type).toBe('not-settled');
		expect(calls.filter((call) => call.args.includes('POST'))).toHaveLength(0);
	});

	test('receipt with absent pr_head_sha refuses head-mismatch (FB-010/md-4)', async () => {
		await seedRun(directory, [record('NH-1', 'LOW', 'src/nh1.ts:1')]);
		const runDir = join(directory, '.swarm', 'pr-review', RUN_ID);
		await fs.writeFile(
			join(runDir, 'trigger-eval.json'),
			JSON.stringify({ run_id: RUN_ID }),
			'utf-8',
		);
		const raw = await execute(validArgs());
		expect(raw).toContain('pr_head_sha');
		expect(JSON.parse(raw).type).toBe('head-mismatch');
		expect(calls).toHaveLength(0);
	});

	test('abort narrowing skips other-session and other-head records (FB-010/md-5)', async () => {
		await seedRun(directory, [record('AN-1', 'LOW', 'src/an1.ts:1')]);
		await fs.mkdir(join(directory, '.swarm'), { recursive: true });
		const events = [
			{
				type: 'pr_workflow_aborted',
				timestamp: '2026-10-06T09:00:00.000Z',
				sessionID: 'some-other-session',
				mode: 'PR_REVIEW',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
			},
			{
				type: 'pr_workflow_aborted',
				timestamp: '2026-10-06T09:00:00.000Z',
				sessionID: PR_ARTIFACT_SESSION_ID,
				mode: 'PR_REVIEW',
				prHeadSha: 'fff000',
			},
		]
			.map((event) => JSON.stringify(event))
			.join('\n');
		await fs.writeFile(
			join(directory, '.swarm', 'events.jsonl'),
			`${events}\n`,
			'utf-8',
		);
		const raw = await execute(validArgs());
		expect(JSON.parse(raw).success).toBe(true);
	});

	test('truncated dedupe GET stdout refuses (FB-010/rb-9)', async () => {
		await seedRun(directory, [record('TS-1', 'LOW', 'src/ts1.ts:1')]);
		submissionInternals.runExternalTool = async (options) => {
			calls.push(options);
			if (options.args.includes('POST')) {
				return defaultRunResult(options);
			}
			return {
				status: 'completed',
				exitCode: 0,
				stdout: '[]',
				stderr: '',
				stdoutTruncated: true,
				stderrTruncated: false,
			};
		};
		const raw = await execute(validArgs());
		const parsed = JSON.parse(raw) as { success: boolean; type: string };
		expect(parsed.success).toBe(false);
		expect(parsed.type).toBe('transport-failed');
		expect(calls.filter((call) => call.args.includes('POST'))).toHaveLength(0);
	});

	test('body size cap truncates with disclosure (FB-010/mb-3)', async () => {
		const longEvidence = 'x'.repeat(400);
		const findings = Array.from({ length: 200 }, (_, index) =>
			record(
				`SZ-${String(index + 1).padStart(3, '0')}`,
				'LOW',
				`src/sz${index}.ts:${index + 1}`,
			),
		).map((item) => ({
			...item,
			evidence: `${longEvidence} ${item.finding_id}`,
		}));
		await seedRun(directory, findings);
		const raw = await execute(validArgs());
		const parsed = JSON.parse(raw) as { success: boolean };
		expect(parsed.success).toBe(true);
		const payload = (await readPayload(calls[calls.length - 1])) as unknown as {
			body: string;
		};
		expect(payload.body.length).toBeLessThanOrEqual(60100);
		expect(payload.body).toContain('Truncated: review body exceeded');
	});

	test('V1-shaped coverage disclosure maps missingDimension (FB-002)', async () => {
		await seedRun(directory, [record('V1-1', 'LOW', 'src/v11.ts:1')]);
		const runDir = join(directory, '.swarm', 'pr-review', RUN_ID);
		await fs.writeFile(
			join(runDir, 'coverage-disclosure.json'),
			JSON.stringify({ missingDimension: 'tests-falsifiability' }),
			'utf-8',
		);
		const raw = await execute(validArgs());
		const payload = (await readPayload(calls[calls.length - 1])) as unknown as {
			body: string;
		};
		expect(payload.body).toContain('PARTIAL');
		expect(payload.body).toContain('tests-falsifiability');
		expect(JSON.parse(raw).success).toBe(true);
	});
});
