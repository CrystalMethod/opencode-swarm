import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

const REPO_ROOT = process.cwd();
const WORKFLOW_PATH = join(
	REPO_ROOT,
	'.github/workflows/host-contract-check.yml',
);

interface WorkflowShape {
	on?: {
		schedule?: Array<{ cron?: string }>;
		workflow_dispatch?: unknown;
		pull_request?: { paths?: string[] };
	};
	permissions?: Record<string, string>;
	jobs?: Record<
		string,
		{
			permissions?: Record<string, string>;
			steps?: Array<{
				uses?: string;
				name?: string;
				if?: string;
				'continue-on-error'?: string | boolean;
				env?: Record<string, string>;
			}>;
		}
	>;
}

function loadWorkflow(): WorkflowShape {
	return load(readFileSync(WORKFLOW_PATH, 'utf8')) as WorkflowShape;
}

describe('host-contract-check workflow (issue #2902)', () => {
	test('the workflow file exists and parses', () => {
		const doc = loadWorkflow();
		expect(doc).toBeTruthy();
		expect(doc.jobs?.check).toBeTruthy();
	});

	test('weekly schedule and workflow_dispatch drive the blocking lane', () => {
		const triggers = loadWorkflow().on;
		expect(triggers?.schedule?.[0]?.cron).toBe('0 13 * * 1');
		expect(triggers?.workflow_dispatch).toBeTruthy();
	});

	test('the PR lane is gated on host-contract surfaces and advisory', () => {
		const paths = loadWorkflow().on?.pull_request?.paths ?? [];
		for (const required of [
			'tests/helpers/host-*',
			'tests/fixtures/host/**',
			'scripts/check-host-contract.ts',
			'bun.lock',
			'package.json',
		]) {
			expect(paths).toContain(required);
		}
		const checkStep = loadWorkflow().jobs?.check?.steps?.find((s) =>
			s.name?.includes('host-contract check'),
		);
		expect(checkStep).toBeTruthy();
		expect(checkStep!['continue-on-error']).toBe(
			"${{ github.event_name == 'pull_request' }}",
		);
	});

	test('routing only runs on non-PR events and is wired with GH_TOKEN', () => {
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		// The routing flag is added only when the event is not a pull_request.
		expect(raw).toContain("github.event_name != 'pull_request'");
		expect(raw).toContain('--route-on-drift');
		const checkStep = loadWorkflow().jobs?.check?.steps?.find((s) =>
			s.name?.includes('host-contract check'),
		);
		expect(checkStep?.env?.GH_TOKEN).toBe('${{ github.token }}');
		expect(checkStep?.env?.GH_REPO).toBe('${{ github.repository }}');
		// The dispatch tag must reach the shell only as an env value — never
		// inline-interpolated (PRR-006 injection class).
		expect(checkStep?.env?.INPUT_TAG).toBe('${{ inputs.tag }}');
		expect(raw.includes('TAG=')).toBe(false);
	});

	test('the job summary step always runs and records the compared tag', () => {
		const summaryStep = loadWorkflow().jobs?.check?.steps?.find((s) =>
			s.name?.includes('summary'),
		);
		expect(summaryStep?.if).toBe('always()');
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		expect(raw).toContain('GITHUB_STEP_SUMMARY');
		expect(raw).toContain('host-contract-output.txt');
	});

	test('issues: write is granted for tracking-issue routing', () => {
		const job = loadWorkflow().jobs?.check;
		expect(job?.permissions?.issues).toBe('write');
		expect(job?.permissions?.contents).toBe('read');
	});

	test('actions are pinned by commit SHA with version comments', () => {
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		for (const action of [
			'actions/checkout',
			'oven-sh/setup-bun',
			'actions/cache',
		]) {
			const m = raw.match(new RegExp(`${action}@[0-9a-f]{40}`));
			expect(m).not.toBeNull();
		}
	});
});
