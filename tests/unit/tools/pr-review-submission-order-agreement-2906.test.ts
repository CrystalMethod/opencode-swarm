// Issue #2906 — submission passthrough arm (plan D7 item 4): a settled
// post_critic findings row carrying order_agreement 'disagree' must reach the
// POSTed review body with its order-unstable marker, proving the
// record → renderer mapping in pr-review-submission.ts threads the field.
// World recipe: seed ONLY trigger-eval.json + findings.jsonl with post_critic
// records; stub the gh transport; run the real executePrReviewSubmission.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { _test_exports } from '../../../src/hooks/pr-workflow-gate.js';
import {
	executePrReviewSubmission,
	_internals as submissionInternals,
} from '../../../src/tools/pr-review-submission.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const RUN_ID = 'order-agreement-submission-run';

interface ExternalToolCall {
	args: string[];
}

let directory = '';
let postCalls: string[];
const originalResolveGhBinary = submissionInternals.resolveGhBinary;
const originalRunExternalTool = submissionInternals.runExternalTool;
const originalHeadAsync = _test_exports.resolveCurrentGitHeadAsync;
const originalDigest = _test_exports.resolvePrWorkflowRevisionDigest;

async function seedSettledOrderUnstableRun(): Promise<void> {
	const runDir = join(directory, '.swarm', 'pr-review', RUN_ID);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(
		join(runDir, 'trigger-eval.json'),
		JSON.stringify({ run_id: RUN_ID, pr_head_sha: PR_ARTIFACT_HEAD_SHA }),
		'utf-8',
	);
	const records = [
		{
			finding_id: 'ORD-1',
			status: 'CONFIRMED',
			file_line: 'src/ord.ts:10',
			evidence: 'flipped across passes',
			next_action: 'report',
			severity: 'MEDIUM',
			order_agreement: 'disagree',
			boundary: 'post_critic',
			pr_head_sha: PR_ARTIFACT_HEAD_SHA,
			recorded_at: '2026-10-12T01:00:00.000Z',
		},
		{
			finding_id: 'ORD-2',
			status: 'CONFIRMED',
			file_line: 'src/ord.ts:20',
			evidence: 'stable across passes',
			next_action: 'report',
			severity: 'MEDIUM',
			order_agreement: 'agree',
			boundary: 'post_critic',
			pr_head_sha: PR_ARTIFACT_HEAD_SHA,
			recorded_at: '2026-10-12T01:00:00.000Z',
		},
		// Review F-02: a flip whose NEWEST pass DISPROVED it. It is not a
		// finding (so it must not reach the findings list or the review
		// event) but it IS order-unstable, so it must be listed and counted.
		{
			finding_id: 'ORD-3',
			status: 'DISPROVED',
			file_line: 'src/ord.ts:30',
			evidence: 'disproved on the second pass',
			next_action: 'report',
			severity: 'NONE',
			order_agreement: 'disagree',
			boundary: 'post_critic',
			pr_head_sha: PR_ARTIFACT_HEAD_SHA,
			recorded_at: '2026-10-12T01:00:00.000Z',
		},
	];
	await fs.writeFile(
		join(runDir, 'findings.jsonl'),
		records.map((record) => JSON.stringify(record)).join('\n'),
		'utf-8',
	);
}

beforeEach(() => {
	directory = canonicalMkdtemp('order-agreement-submission-');
	postCalls = [];
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
	submissionInternals.resolveGhBinary = () => '/fake/gh';
	submissionInternals.runExternalTool = async (options: ExternalToolCall) => {
		const isPost = options.args.includes('POST');
		if (isPost) {
			// The review body rides the POST via --input -; capture stdin from
			// the payload file the tool writes instead of the pipe.
			const bodyIndex = options.args.indexOf('--input');
			postCalls.push(options.args.slice(0, bodyIndex).join(' '));
			return {
				status: 'completed',
				exitCode: 0,
				stdout: '{"id":9,"html_url":"https://example.com/review/9"}',
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		}
		return {
			status: 'completed',
			exitCode: 0,
			stdout: '[]',
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

describe('submission order_agreement passthrough (issue #2906)', () => {
	test('a disagreeing settled row renders its order-unstable marker in the POSTed body', async () => {
		await seedSettledOrderUnstableRun();
		const payloadPath = join(directory, '.swarm', 'pr-review', RUN_ID);
		const result = await executePrReviewSubmission(
			{
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				pr_number: 929,
				repo: 'example/example-repo',
				run_id: RUN_ID,
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		expect(result).toContain('"success": true');
		// The submission payload copy is the durable evidence of what was
		// POSTed: the rendered body must carry the marker on ORD-1 only and
		// the unstable summary line.
		const payload = JSON.parse(
			await fs.readFile(join(payloadPath, 'submission-payload.json'), 'utf-8'),
		) as { body: string };
		const lines = payload.body.split('\n');
		const ord1 = lines.find((line) => line.includes('[ORD-1]'));
		const ord2 = lines.find((line) => line.includes('[ORD-2]'));
		expect(ord1 ?? '').toContain('order-unstable');
		expect(ord2 ?? '').not.toContain('order-unstable');
		expect(
			lines.some(
				(line) =>
					line.includes('order-unstable') &&
					/[0-9]/.test(line) &&
					!line.includes('[ORD-'),
			),
		).toBe(true);
	});

	test('a DISPROVED order-unstable row is listed and counted without becoming a finding', async () => {
		await seedSettledOrderUnstableRun();
		const payloadPath = join(directory, '.swarm', 'pr-review', RUN_ID);
		const result = await executePrReviewSubmission(
			{
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				pr_number: 929,
				repo: 'example/example-repo',
				run_id: RUN_ID,
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		expect(result).toContain('"success": true');
		const payload = JSON.parse(
			await fs.readFile(join(payloadPath, 'submission-payload.json'), 'utf-8'),
		) as { body: string };
		const body = payload.body;
		// ORD-3 is DISPROVED: it must NOT appear in the findings list...
		const findingsSection = body.slice(
			body.indexOf('## Findings'),
			body.indexOf('## Order-unstable'),
		);
		expect(findingsSection).not.toContain('ORD-3');
		// ...but it IS order-unstable, so it must be listed with its final
		// status and counted. Two unstable rows total: ORD-1 and ORD-3.
		expect(body).toContain('## Order-unstable (not published as findings)');
		const ord3 = body.split('\n').find((line) => line.includes('[ORD-3]'));
		expect(ord3 ?? '').toContain('order-unstable');
		expect(ord3 ?? '').toContain('disproved');
		expect(body).toContain('2 finding(s) order-unstable');
		// Exactly one summary sentence, whatever the mix.
		expect(
			body.split('\n').filter((line) => line.includes('order-unstable across')),
		).toHaveLength(1);
	});
});
