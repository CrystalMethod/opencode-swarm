/**
 * Pins the flake-detection issue dedupe (issue #3248 AC6).
 *
 * Before this change, scripts/ci/detect-and-quarantine-flakes.sh created a
 * NEW tracking issue after every failed merge-group run — 84 same-titled
 * duplicates in the 2026-09/10 cohort, one per failed run, because the
 * flake-detection workflow only fires when a run fails and every failing run
 * carries retry-flake annotations. The script now searches for an OPEN issue
 * with the exact title first and comments there instead.
 *
 * Source-text pins (executing the script needs a gh binary + network; the
 * repo's precedent for pinning CI-script wiring by source scan is
 * tests/unit/scripts/ci/ci-yml-integration.test.ts for the workflow).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const DETECTOR = path.join(
	REPO_ROOT,
	'scripts',
	'ci',
	'detect-and-quarantine-flakes.sh',
);
const WORKFLOW = path.join(
	REPO_ROOT,
	'.github',
	'workflows',
	'flake-detection.yml',
);

describe('flake-detection tracking-issue dedupe (issue #3248)', () => {
	const script = fs.readFileSync(DETECTOR, 'utf-8');

	test('defines the canonical tracking title once and creates with it', () => {
		expect(script).toContain(
			'TRACKING_TITLE="Auto-detected flaky tests (merge-group) — review for quarantine"',
		);
		expect(script).toContain('--title "$TRACKING_TITLE"');
	});

	test('searches for an existing OPEN issue before creating (server-side filter)', () => {
		// The search phrase must be title-scoped so the repo's 100+ other
		// open issues cannot crowd the result window; --json + --template
		// extraction avoids a jq dependency.
		expect(script).toContain(
			'--search "in:title \\"Auto-detected flaky tests (merge-group)\\""',
		);
		expect(script).toContain('--json number,title');
		expect(script).toContain('--template');
	});

	test('exact-title matching selects the existing issue (em-dash title is byte-compared)', () => {
		expect(script).toContain('[ "$cand_title" = "$TRACKING_TITLE" ]');
	});

	test('the lookup delimiter is a literal TAB in both the template and IFS', () => {
		// A mutation to a space delimiter would silently disable matching
		// (cand_number absorbs the whole row) while every other pin still
		// passes — pin the byte itself.
		expect(script).toContain('IFS="\t"');
		expect(script).toContain('{{.number}}\t{{.title}}');
	});

	test('comments on the existing issue instead of creating a duplicate', () => {
		expect(script).toContain('gh issue comment "$existing_issue"');
		// The comment route must be tried BEFORE the create route.
		const commentAt = script.indexOf('gh issue comment "$existing_issue"');
		const createAt = script.indexOf('gh issue create --repo "$REPO"');
		expect(commentAt).toBeGreaterThan(-1);
		expect(createAt).toBeGreaterThan(commentAt);
	});

	test('the comment body is distinguishable from a fresh-issue body', () => {
		expect(script).toContain(
			'This comment was added automatically by the flake-detection',
		);
	});

	test('the report body cites the triggering CI run when the URL is provided', () => {
		expect(script).toContain('${DETECTION_RUN_URL:-}');
		expect(script).toContain('Triggering CI run: ${DETECTION_RUN_URL}');
	});

	test('every gh call stays warn-only (detection never fails the workflow)', () => {
		expect(script.trimEnd().endsWith('exit 0')).toBe(true);
		// The two lookup/create/comment failure paths must not exit non-zero.
		expect(script).toContain('::warning::gh issue comment');
		expect(script).toContain('::warning::gh issue create');
	});

	test('the workflow passes the triggering run URL to the script', () => {
		const workflow = fs.readFileSync(WORKFLOW, 'utf-8');
		expect(workflow).toContain(
			'DETECTION_RUN_URL: ${{ github.event.workflow_run.html_url }}',
		);
	});
});
