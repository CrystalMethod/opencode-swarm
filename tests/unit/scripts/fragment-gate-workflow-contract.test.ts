import { afterAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';
import { bashCommand } from '../../helpers/bash';

/**
 * Executable coverage for the release-fragment arms' classifier exit-code
 * mapping (issue #2955, review round 1 finding TF-005 / A3).
 *
 * Three required checks route their verdict through a `case "$rc"` block over
 * `bun scripts/check-pending-fragment.ts --print-requirement`. Those blocks
 * had no executing test, so a swapped arm, an inverted comparison or a
 * dropped fail-closed branch would ship green. Here the real workflow files
 * are parsed, the real `case` blocks are EXTRACTED from them, and each
 * extracted block is executed with a stubbed classifier so the mapping — not a
 * re-implementation of it — is what is under test.
 *
 * The classifier itself is stubbed because these cases are about the shell
 * mapping: `stub-classifier.sh <exit-code> <verdict-line>` echoes the verdict
 * and exits with the given code, which is exactly the shape the real CLI
 * produces (a violation is rc 1 WITH a verdict line; a bun crash is rc 1 with
 * no stdout; a usage error is rc 2).
 */

const root = path.resolve(import.meta.dir, '../../..');
const prStandardsPath = path.join(root, '.github/workflows/pr-standards.yml');
const releasePath = path.join(
	root,
	'.github/workflows/release-and-publish.yml',
);
const prStandards = parse(readFileSync(prStandardsPath, 'utf8'));
const releaseWorkflow = parse(readFileSync(releasePath, 'utf8'));

/** Extract the `run:` block of a step by name from a parsed workflow. */
function runBlock(workflow: any, job: string, stepName: string): string {
	const steps: any[] = workflow.jobs[job].steps;
	const step = steps.find((s: any) => s.name === stepName);
	if (!step) throw new Error(`step not found: ${job} / ${stepName}`);
	if (typeof step.run !== 'string')
		throw new Error(`step has no run: ${job} / ${stepName}`);
	return step.run;
}

/**
 * Extract the classifier dispatch + `case "$rc"` mapping from a step body:
 * everything from the line that invokes the classifier to the `esac` that
 * closes its case statement. Executing that slice is what makes the test
 * cover the real mapping.
 */
function classifierMapping(block: string): string {
	const lines = block.split('\n');
	const callIndex = lines.findIndex((l) => l.includes('--print-requirement'));
	if (callIndex === -1) throw new Error('no classifier invocation in step');
	// Start at the `rc=0` seed so the extracted slice is self-contained.
	let start = callIndex;
	for (let i = callIndex; i >= 0; i--) {
		if (/^\s*\w*rc=0\s*$/.test(lines[i])) {
			start = i;
			break;
		}
	}
	// The mapping's `esac` is the first one at the same indentation as its
	// `case` — arms are indented deeper, so an indent match is sufficient and
	// immune to any nested case/esac inside an arm.
	const caseIndex = lines.findIndex(
		(l, i) => i > start && /^\s*case\s+"\$\w*rc"\s+in\s*$/.test(l),
	);
	if (caseIndex === -1)
		throw new Error('no case "$rc" statement after the classifier call');
	const caseIndent = lines[caseIndex].match(/^\s*/)?.[0] ?? '';
	let end = -1;
	for (let i = caseIndex + 1; i < lines.length; i++) {
		if (lines[i] === `${caseIndent}esac`) {
			end = i;
			break;
		}
	}
	if (end === -1)
		throw new Error('no esac terminator for the classifier mapping');
	return ['set -uo pipefail', ...lines.slice(start, end + 1)].join('\n');
}

/** Run an extracted mapping with a stubbed classifier (rc + verdict). */
function runMapping(
	mapping: string,
	opts: {
		rc: number;
		verdict: string;
		added?: string;
		/** Dispatched-arm (issue #3290) stub inputs. */
		entries?: string[];
		changedFiles?: number;
		headSha?: string;
		/** When set, the stubbed bun's argv is appended to this file. */
		captureBunArgs?: string;
		/** When set, the stubbed gh's argv is appended to this file. */
		captureGhArgs?: string;
	},
): { exitCode: number; stdout: string; stderr: string } {
	// Seeds for the #3290 mapping slices. The temp files carry the SAME
	// bytes the arms write (NUL-framed for the pull_request arm's slice);
	// the legacy changed/added/classifier_args seeds stay for shape
	// compatibility with any residual references.
	const tmpChanged = `${import.meta.dir}/.tmp-3290-changed-${process.pid}`;
	const tmpAdded = `${import.meta.dir}/.tmp-3290-added-${process.pid}`;
	writeFileSync(
		tmpChanged,
		Buffer.from(`src/index.ts${'\0'}docs/other.ts${'\0'}`, 'utf8'),
	);
	writeFileSync(
		tmpAdded,
		Buffer.from(
			`${opts.added ?? 'docs/releases/pending/mine.md'}${'\0'}`,
			'utf8',
		),
	);
	const entries = opts.entries ?? [
		'{"filename":"src/index.ts","status":"modified","changes":3}',
		'{"filename":"docs/releases/pending/mine.md","status":"added","changes":10}',
	];
	const changedFiles = opts.changedFiles ?? entries.length;
	const headSha = opts.headSha ?? 'deadbeefcafe';
	const script = [
		'changed="src/index.ts"',
		// Single-quoted so an adversarial fragment name containing a double
		// quote (the #3290 display test) survives the seed line.
		`added='${opts.added ?? 'docs/releases/pending/mine.md'}'`,
		'classifier_args=()',
		`tmp_changed='${tmpChanged}'`,
		`tmp_added='${tmpAdded}'`,
		`pr_json='{"changed_files":${changedFiles},"head":{"sha":"deadbeefcafe"}}'`,
		'PR_NUMBER=1234',
		'GITHUB_SHA=deadbeefcafe',
		'GITHUB_REPOSITORY=example/example',
		`TEST_ENTRIES='${entries.join('\n')}'`,
		`TEST_HEAD_SHA='${headSha}'`,
		opts.captureBunArgs
			? `CAPTURE_BUN='${opts.captureBunArgs}'`
			: 'CAPTURE_BUN=',
		opts.captureGhArgs ? `CAPTURE_GH='${opts.captureGhArgs}'` : 'CAPTURE_GH=',
		'gh() {',
		'  local line="$*"',
		'  [ -n "$CAPTURE_GH" ] && printf \'%s\\n\' "$@" >> "$CAPTURE_GH"',
		'  case "$line" in',
		"    *'files?per_page=100'*)",
		'      printf \'%s\\n\' "$TEST_ENTRIES"',
		'      return 0',
		'      ;;',
		'    *)',
		'      printf \'%s\\n\' "$TEST_HEAD_SHA"',
		'      return 0',
		'      ;;',
		'  esac',
		'}',
		'bun() {',
		'  [ -n "$CAPTURE_BUN" ] && { printf \'%s\\n\' "$@" >> "$CAPTURE_BUN"',
		// The arm's EXIT trap deletes the temp files when the mapping script
		// ends, so the stub snapshots their CONTENTS at call time.
		'    printf \'<<<CHANGED\\n\' >> "$CAPTURE_BUN"',
		'    cat "${tmp_changed:-/dev/null}" >> "$CAPTURE_BUN" 2>/dev/null || true',
		'    printf \'\\n<<<ADDED\\n\' >> "$CAPTURE_BUN"',
		'    cat "${tmp_added:-/dev/null}" >> "$CAPTURE_BUN" 2>/dev/null || true',
		'  }',
		`  [ -n '${opts.verdict}' ] && printf '%s\\n' '${opts.verdict}'`,
		`  return ${opts.rc}`,
		'}',
		mapping,
	].join('\n');
	const proc = Bun.spawnSync({
		cmd: bashCommand('-s'),
		cwd: root,
		stdin: Buffer.from(script, 'utf8'),
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	return {
		exitCode: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

const VIOLATION = 'required=true satisfied=false';
const SATISFIED = 'required=true satisfied=true';

afterAll(() => {
	// The pull_request mapping slice carries no cleanup trap (the arm's trap
	// lives before the extraction seed), so sweep the harness temp files.
	for (const p of readdirSync(import.meta.dir)) {
		if (p.startsWith('.tmp-3290-')) {
			unlinkSync(path.join(import.meta.dir, p));
		}
	}
});
const NOT_REQUIRED = 'required=false satisfied=false';

describe('fragment-gate workflow exit mapping (issue #2955)', () => {
	const pullRequestMapping = classifierMapping(
		runBlock(prStandards, 'pr-standards', 'Require pending release fragment'),
	);

	test('pull_request arm: rc 0 + not-required accepts', () => {
		const result = runMapping(pullRequestMapping, {
			rc: 0,
			verdict: NOT_REQUIRED,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			'Docs/workflow/meta-only change without release fragment accepted.',
		);
	});

	test('pull_request arm: rc 0 + satisfied accepts and names the fragment', () => {
		const result = runMapping(pullRequestMapping, {
			rc: 0,
			verdict: SATISFIED,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Release fragment present:');
		expect(result.stdout).toContain('docs/releases/pending/mine.md');
	});

	test('pull_request arm: rc 1 + violation verdict reports the missing fragment', () => {
		const result = runMapping(pullRequestMapping, {
			rc: 1,
			verdict: VIOLATION,
		});
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain(
			'Missing docs/releases/pending/<unique-slug>.md release fragment',
		);
		expect(result.stdout).not.toContain('classifier failed');
	});

	test('pull_request arm: rc 1 with NO verdict (a bun crash) is NOT blamed on the fragment', () => {
		// bun exits 1 on a crash as well as on a violation. Mapping both to
		// "add a fragment" sent authors after a fix that could not help.
		const result = runMapping(pullRequestMapping, { rc: 1, verdict: '' });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('Fragment classifier failed');
		expect(result.stdout).not.toContain(
			'Missing docs/releases/pending/<unique-slug>.md release fragment',
		);
	});

	test('pull_request arm: rc 2 fails closed as an unusable classifier', () => {
		const result = runMapping(pullRequestMapping, { rc: 2, verdict: '' });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('Fragment classifier unusable (exit 2)');
	});

	const dispatchedMapping = classifierMapping(
		runBlock(prStandards, 'pr-standards', 'Validate dispatched PR contract'),
	);

	test('dispatched arm: rc 0 accepts', () => {
		const result = runMapping(dispatchedMapping, { rc: 0, verdict: SATISFIED });
		expect(result.exitCode).toBe(0);
	});

	test('dispatched arm: rc 1 + violation verdict fails the PR', () => {
		const result = runMapping(dispatchedMapping, { rc: 1, verdict: VIOLATION });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain(
			'Dispatched PR is missing a pending release fragment.',
		);
	});

	test('dispatched arm: rc 1 with NO verdict (a bun crash) is not blamed on the fragment', () => {
		const result = runMapping(dispatchedMapping, { rc: 1, verdict: '' });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('Fragment classifier failed');
		expect(result.stdout).not.toContain(
			'Dispatched PR is missing a pending release fragment.',
		);
	});

	const cleanupMapping = classifierMapping(
		runBlock(
			releaseWorkflow,
			'cleanup-release-fragments',
			'Open cleanup PR and dispatch required checks',
		),
	);

	test('cleanup arm: required=false passes (the cleanup PR owes no fragment)', () => {
		const result = runMapping(cleanupMapping, { rc: 0, verdict: NOT_REQUIRED });
		expect(result.exitCode).toBe(0);
	});

	test('cleanup arm: required=true errors — the cleanup PR unexpectedly needs a fragment', () => {
		const result = runMapping(cleanupMapping, { rc: 0, verdict: SATISFIED });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain(
			'Cleanup PR unexpectedly requires a pending release fragment.',
		);
	});

	test('cleanup arm: an unusable classifier (rc 2) fails closed', () => {
		const result = runMapping(cleanupMapping, { rc: 2, verdict: '' });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('Fragment classifier unusable (exit 2)');
	});

	// ---- issue #3290: dispatched-arm listing integrity + transports ----
	// These execute the REAL extracted dispatched-arm block (now including
	// the mktemp/trap/listing/completeness/head-re-assertion/derivation
	// preamble between the rc=0 seed and the classifier call) against the
	// call-sensitive gh() stub and real jq/wc/mktemp.

	test('dispatched arm 3290: a truncated listing fails closed with both counts', () => {
		const result = runMapping(dispatchedMapping, {
			rc: 0,
			verdict: '',
			entries: ['{"filename":"src/index.ts","status":"modified","changes":3}'],
			changedFiles: 5,
		});
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('Files listing incomplete');
		expect(result.stdout).toContain('1 entries');
		expect(result.stdout).toContain('5 changed files');
	});

	test('dispatched arm 3290: a head move after the listing fails closed', () => {
		const result = runMapping(dispatchedMapping, {
			rc: 0,
			verdict: '',
			headSha: 'moved0ff0',
		});
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('PR head moved');
		expect(result.stdout).toContain('moved0ff0');
	});

	test('dispatched arm 3290: happy path derives both lists from the one listing', () => {
		const capture = `${import.meta.dir}/.tmp-3290-bunargs-${process.pid}`;
		writeFileSync(capture, '');
		const result = runMapping(dispatchedMapping, {
			rc: 0,
			verdict: 'required=true satisfied=true',
			entries: [
				'{"filename":"src/index.ts","status":"modified","changes":3}',
				'{"filename":"docs/releases/pending/mine.md","status":"added","changes":10}',
				'{"filename":"src/old.ts","status":"renamed","changes":4,"previous_filename":"src/older.ts"}',
			],
			changedFiles: 3,
			captureBunArgs: capture,
		});
		expect(result.exitCode).toBe(0);
		const captureText = readFileSync(capture, 'utf8');
		const args = captureText.split('\n');
		expect(args).toContain('--paths-format');
		expect(args[args.indexOf('--paths-format') + 1]).toBe('jsonl');
		// The stub snapshots the derived files at call time (the arm's EXIT
		// trap deletes them when the mapping script ends).
		const changedContent = captureText
			.split('<<<CHANGED\n')[1]
			.split('\n<<<ADDED')[0];
		const addedContent = captureText.split('<<<ADDED\n')[1];
		// The rename contributes BOTH paths to the changed list and (because
		// .changes > 0) its new path to the added list.
		expect(changedContent).toContain('"src/index.ts"');
		expect(changedContent).toContain('"src/old.ts"');
		expect(changedContent).toContain('"src/older.ts"');
		expect(addedContent).toContain('"docs/releases/pending/mine.md"');
		expect(addedContent).toContain('"src/old.ts"');
		unlinkSync(capture);
	});

	test('dispatched arm 3290: the listing uses --jq .[] exactly', () => {
		const capture = `${import.meta.dir}/.tmp-3290-ghargs-${process.pid}`;
		writeFileSync(capture, '');
		runMapping(dispatchedMapping, {
			rc: 0,
			verdict: 'required=true satisfied=true',
			captureGhArgs: capture,
		});
		const args = readFileSync(capture, 'utf8').split('\n');
		const listingIndex = args.findIndex((a) =>
			a.includes('files?per_page=100'),
		);
		expect(listingIndex).toBeGreaterThanOrEqual(0);
		// `--jq` followed by `.[]`: `--jq '.'` (per-page arrays) and
		// `--jq -c '.'` (invalid gh syntax) both fail this.
		expect(args[listingIndex + 1]).toBe('--jq');
		expect(args[listingIndex + 2]).toBe('.[]');
		unlinkSync(capture);
	});

	test('pull_request arm 3290: the display renders an adversarial added fragment name', () => {
		const result = runMapping(pullRequestMapping, {
			rc: 0,
			verdict: 'required=true satisfied=true',
			added: 'docs/releases/pending/we"ird-3290.md',
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Release fragment present:');
		expect(result.stdout).toContain('docs/releases/pending/we"ird-3290.md');
	});
});
