import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_TOOL_MAP } from '../../../src/config/constants.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	_test_exports,
	activatePrWorkflow,
} from '../../../src/hooks/pr-workflow-gate.js';
import * as toolsBarrel from '../../../src/tools/index.js';
import { TOOL_MANIFEST } from '../../../src/tools/manifest.js';
import {
	executePrReviewSubmission,
	pr_review_submission,
	_internals as submissionInternals,
} from '../../../src/tools/pr-review-submission.js';
import { TOOL_METADATA, TOOL_NAMES } from '../../../src/tools/tool-metadata.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const RUN_ID = 'tool-authz-run';
const OTHER_HEAD_SHA = 'fff000';

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
	message?: string;
}

let directory = '';
let calls: ExternalToolCall[];
const originalResolveGhBinary = submissionInternals.resolveGhBinary;
const originalRunExternalTool = submissionInternals.runExternalTool;
const originalHeadAsync = _test_exports.resolveCurrentGitHeadAsync;
const originalDigest = _test_exports.resolvePrWorkflowRevisionDigest;

async function seedSettledRun(
	root: string,
	options: {
		headSha?: string;
		boundary?: string;
		mixedHead?: boolean;
	} = {},
): Promise<void> {
	const headSha = options.headSha ?? PR_ARTIFACT_HEAD_SHA;
	const boundary = options.boundary ?? 'post_critic';
	const runDir = join(root, '.swarm', 'pr-review', RUN_ID);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(
		join(runDir, 'trigger-eval.json'),
		JSON.stringify({ run_id: RUN_ID, pr_head_sha: headSha }),
		'utf-8',
	);
	const records = [
		{
			finding_id: 'AUTH-1',
			status: 'CONFIRMED',
			file_line: 'src/auth.ts:10',
			evidence: 'settled evidence',
			next_action: 'report',
			severity: 'LOW',
			boundary,
			pr_head_sha: headSha,
			recorded_at: '2026-10-06T01:00:00.000Z',
		},
	];
	if (options.mixedHead) {
		records.push({
			finding_id: 'AUTH-2',
			status: 'CONFIRMED',
			file_line: 'src/auth2.ts:11',
			evidence: 'other head',
			next_action: 'report',
			severity: 'LOW',
			boundary,
			pr_head_sha: OTHER_HEAD_SHA,
			recorded_at: '2026-10-06T01:00:00.000Z',
		});
	}
	await fs.writeFile(
		join(runDir, 'findings.jsonl'),
		records.map((record) => JSON.stringify(record)).join('\n'),
		'utf-8',
	);
}

async function seedAbortEvent(
	root: string,
	timestamp: string,
	headSha = PR_ARTIFACT_HEAD_SHA,
): Promise<void> {
	const eventsPath = join(root, '.swarm', 'events.jsonl');
	const line = JSON.stringify({
		type: 'pr_workflow_aborted',
		timestamp,
		sessionID: PR_ARTIFACT_SESSION_ID,
		mode: 'PR_REVIEW',
		kind: 'manual',
		prHeadSha: headSha,
	});
	await fs.mkdir(join(root, '.swarm'), { recursive: true });
	await fs.writeFile(eventsPath, `${line}\n`, 'utf-8');
}

function validArgs(): Record<string, unknown> {
	return {
		pr_head_sha: PR_ARTIFACT_HEAD_SHA,
		pr_number: 909,
		repo: 'example/example-repo',
		run_id: RUN_ID,
	};
}

async function execute(args: unknown): Promise<string> {
	return executePrReviewSubmission(args, directory, {
		sessionID: PR_ARTIFACT_SESSION_ID,
	});
}

beforeEach(() => {
	directory = canonicalMkdtemp('pr-review-submission-');
	calls = [];
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
	submissionInternals.resolveGhBinary = () => '/fake/gh';
	submissionInternals.runExternalTool = async (options) => {
		calls.push(options);
		const isGet = !options.args.includes('POST');
		const stdout = isGet
			? '[]'
			: '{"id":7,"html_url":"https://example.com/review/7"}';
		return {
			status: 'completed',
			exitCode: 0,
			stdout,
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		};
	};
});

afterEach(async () => {
	submissionInternals.resolveGhBinary = originalResolveGhBinary;
	submissionInternals.runExternalTool = originalRunExternalTool;
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHeadAsync = originalHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalDigest;
	closeAllProjectDbs();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('pr_review_submission registration (issue #3096 AC1/AC5)', () => {
	test('registers additively across metadata, manifest, and barrel', () => {
		expect(pr_review_submission).toBeTruthy();
		expect(TOOL_NAMES).toContain('pr_review_submission');
		expect(TOOL_METADATA.pr_review_submission?.agents).toEqual(['architect']);
		expect(
			Object.hasOwn(TOOL_METADATA.pr_review_submission ?? {}, 'prWorkflow'),
		).toBe(false);
		expect(typeof TOOL_MANIFEST.pr_review_submission).toBe('function');
		expect(toolsBarrel.pr_review_submission).toBeTruthy();
		expect(AGENT_TOOL_MAP.architect).toContain('pr_review_submission');
		expect(AGENT_TOOL_MAP.explorer).not.toContain('pr_review_submission');
	});
});

describe('pr_review_submission args contract (AC1)', () => {
	test('refuses invalid args before any transport', async () => {
		const cases: Array<Record<string, unknown>> = [
			{ pr_number: 909, repo: 'example/example-repo', run_id: RUN_ID },
			{
				pr_head_sha: 'nothex',
				pr_number: 909,
				repo: 'example/example-repo',
				run_id: RUN_ID,
			},
			{
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				pr_number: 0,
				repo: 'example/example-repo',
				run_id: RUN_ID,
			},
			{
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				pr_number: 909,
				repo: 'not a slug',
				run_id: RUN_ID,
			},
			{
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				pr_number: 909,
				repo: 'example/example-repo',
				run_id: '../escape',
			},
		];
		for (const args of cases) {
			const raw = await execute(args);
			expect(/pr_head_sha|Invalid/i.test(raw)).toBe(true);
			const parsed = JSON.parse(raw);
			expect(parsed.success).toBe(false);
			expect(parsed.type).toBe('invalid-args');
		}
		expect(calls).toHaveLength(0);
	});
});

describe('pr_review_submission authorization ladder (AC2)', () => {
	test('refuses with BLOCKED while a PR_REVIEW gate is active', async () => {
		await seedSettledRun(directory);
		await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		const raw = await execute(validArgs());
		expect(raw).toContain('BLOCKED');
		expect(calls).toHaveLength(0);
	});

	test('refuses an abort recorded at/after settlement', async () => {
		await seedSettledRun(directory);
		await seedAbortEvent(directory, '2026-10-06T02:00:00.000Z');
		const raw = await execute(validArgs());
		expect(raw).toContain('BLOCKED');
		expect(JSON.parse(raw).type).toBe('aborted');
		expect(calls).toHaveLength(0);
	});

	test('allows an abort recorded before a later settlement (recovery flow)', async () => {
		await seedSettledRun(directory);
		await seedAbortEvent(directory, '2026-09-01T00:00:00.000Z');
		const raw = await execute(validArgs());
		expect(JSON.parse(raw).success).toBe(true);
	});

	test('refuses a head mismatch against the trigger receipt', async () => {
		await seedSettledRun(directory, { headSha: OTHER_HEAD_SHA });
		const raw = await execute(validArgs());
		expect(raw).toContain('pr_head_sha');
		expect(JSON.parse(raw).success).toBe(false);
		expect(calls).toHaveLength(0);
	});

	test('refuses a receipt head mismatch even when records match the declared head', async () => {
		// Isolates the receipt-equality branch: findings records bind to the
		// declared head, so only the trigger receipt mismatch can refuse.
		await seedSettledRun(directory, { headSha: PR_ARTIFACT_HEAD_SHA });
		const runDir = join(directory, '.swarm', 'pr-review', RUN_ID);
		await fs.writeFile(
			join(runDir, 'trigger-eval.json'),
			JSON.stringify({ run_id: RUN_ID, pr_head_sha: OTHER_HEAD_SHA }),
			'utf-8',
		);
		const raw = await execute(validArgs());
		expect(raw).toContain('pr_head_sha');
		expect(JSON.parse(raw).type).toBe('head-mismatch');
		expect(calls).toHaveLength(0);
	});

	test('refuses when no artifacts exist', async () => {
		const raw = await execute(validArgs());
		expect(JSON.parse(raw).success).toBe(false);
		expect(calls).toHaveLength(0);
	});

	test('refuses records without a post_critic boundary', async () => {
		await seedSettledRun(directory, { boundary: 'post_reviewer' });
		const raw = await execute(validArgs());
		expect(JSON.parse(raw).type).toBe('not-settled');
		expect(calls).toHaveLength(0);
	});

	test('refuses findings records bound to a different head', async () => {
		await seedSettledRun(directory, { mixedHead: true });
		const raw = await execute(validArgs());
		expect(raw).toContain('pr_head_sha');
		expect(JSON.parse(raw).type).toBe('head-mismatch');
		expect(calls).toHaveLength(0);
	});

	test('refuses without a session ID', async () => {
		await seedSettledRun(directory);
		const raw = await executePrReviewSubmission(validArgs(), directory, {});
		expect(/Invalid/i.test(raw)).toBe(true);
		expect(JSON.parse(raw).success).toBe(false);
		expect(calls).toHaveLength(0);
	});

	test('refuses a trigger receipt bound to a different run_id', async () => {
		await seedSettledRun(directory);
		const runDir = join(directory, '.swarm', 'pr-review', RUN_ID);
		await fs.writeFile(
			join(runDir, 'trigger-eval.json'),
			JSON.stringify({
				run_id: 'a-different-run',
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
			}),
			'utf-8',
		);
		const raw = await execute(validArgs());
		expect(JSON.parse(raw).success).toBe(false);
		expect(calls).toHaveLength(0);
	});
});

describe('pr_review_submission feedback round (PRR fixes)', () => {
	test('renders only the settled post_critic records, never superseded ones (PRR-001)', async () => {
		await seedSettledRun(directory);
		const runDir = join(directory, '.swarm', 'pr-review', RUN_ID);
		const superseded = [
			JSON.stringify({
				finding_id: 'SUP-1',
				status: 'CONFIRMED',
				file_line: 'src/sup.ts:1',
				evidence: 'stale pre-critic evidence',
				next_action: 'report',
				severity: 'HIGH',
				boundary: 'post_explorer',
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				recorded_at: '2026-10-06T00:00:00.000Z',
			}),
			JSON.stringify({
				finding_id: 'DEAD-1',
				status: 'DISPROVED',
				file_line: 'src/dead.ts:2',
				evidence: 'disproved by critic',
				next_action: 'suppress_with_reason',
				severity: 'NONE',
				boundary: 'post_critic',
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				recorded_at: '2026-10-06T01:00:00.000Z',
			}),
		].join('\n');
		const settledRecord = JSON.stringify({
			finding_id: 'SET-1',
			status: 'CONFIRMED',
			file_line: 'src/set.ts:3',
			evidence: 'settled low finding',
			next_action: 'report',
			severity: 'LOW',
			boundary: 'post_critic',
			pr_head_sha: PR_ARTIFACT_HEAD_SHA,
			recorded_at: '2026-10-06T01:00:00.000Z',
		});
		await fs.writeFile(
			join(runDir, 'findings.jsonl'),
			`${superseded}\n${settledRecord}\n`,
			'utf-8',
		);
		const raw = await execute(validArgs());
		const payload = JSON.parse(
			await fs.readFile(join(runDir, 'submission-payload.json'), 'utf-8'),
		) as { event: string; body: string; comments: unknown[] };
		// Settled severities only: the stale HIGH explorer record must not
		// force REQUEST_CHANGES, and the DISPROVED record must not render.
		expect(payload.event).toBe('COMMENT');
		expect(payload.body).not.toContain('stale pre-critic evidence');
		expect(payload.body).not.toContain('DEAD-1');
		expect(payload.body).toContain('SET-1');
		expect(JSON.parse(raw).success).toBe(true);
	});

	test('refuses on a corrupt coverage disclosure instead of claiming FULL (PRR-002/ma-p3)', async () => {
		await seedSettledRun(directory);
		const runDir = join(directory, '.swarm', 'pr-review', RUN_ID);
		await fs.writeFile(
			join(runDir, 'coverage-disclosure.json'),
			'{ truncated json',
			'utf-8',
		);
		const raw = await execute(validArgs());
		const parsed = JSON.parse(raw) as { success: boolean; type: string };
		expect(parsed.success).toBe(false);
		expect(parsed.type).toBe('not-settled');
		expect(calls).toHaveLength(0);
	});

	test('maps V2 object-shaped unresolvedDimensions to dimension names (PRR-002)', async () => {
		await seedSettledRun(directory);
		const runDir = join(directory, '.swarm', 'pr-review', RUN_ID);
		await fs.writeFile(
			join(runDir, 'coverage-disclosure.json'),
			JSON.stringify({
				schemaVersion: 2,
				runId: RUN_ID,
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				revisionDigest: 'rev-1',
				unresolvedDimensions: [
					{
						dimension: 'security-trust',
						terminalState: 'FAILED',
						reasonKind: 'lane_failure',
					},
					{
						dimension: 'reliability-performance',
						terminalState: 'CANCELLED',
						reasonKind: 'cancelled',
					},
				],
				admittedAt: '2026-10-06T01:00:00.000Z',
			}),
			'utf-8',
		);
		const raw = await execute(validArgs());
		const runDirPayload = JSON.parse(
			await fs.readFile(join(runDir, 'submission-payload.json'), 'utf-8'),
		) as { body: string };
		expect(runDirPayload.body).toContain('PARTIAL');
		expect(runDirPayload.body).toContain('security-trust');
		expect(runDirPayload.body).toContain('reliability-performance');
		expect(JSON.parse(raw).success).toBe(true);
	});

	test('refuses with aborted-indeterminate when the events file is unreadable (PRR-009)', async () => {
		await seedSettledRun(directory);
		await fs.mkdir(join(directory, '.swarm'), { recursive: true });
		// An events file that exists but yields no readable window.
		await fs.writeFile(
			join(directory, '.swarm', 'events.jsonl'),
			'   \n',
			'utf-8',
		);
		const raw = await execute(validArgs());
		const parsed = JSON.parse(raw) as { success: boolean; type: string };
		expect(parsed.success).toBe(false);
		expect(parsed.type).toBe('aborted-indeterminate');
		expect(calls).toHaveLength(0);
	});

	test('refuses a PR_FEEDBACK-mode gate the same as PR_REVIEW (md-3)', async () => {
		await seedSettledRun(directory);
		await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_FEEDBACK', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		const raw = await execute(validArgs());
		const parsed = JSON.parse(raw) as { success: boolean; type: string };
		expect(parsed.success).toBe(false);
		expect(parsed.type).toBe('gate-active');
		expect(parsed.blocked).toBe(true);
		expect(calls).toHaveLength(0);
	});
});
